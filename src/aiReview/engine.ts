import * as path from 'path';
import { collectStaged, collectCommit, collectMerge, collectRebase, collectSync } from './diff';
import { loadRules, ensureRulesFile } from './rules';
import { buildPrompt } from './prompt';
import { resolveBackend, callCli } from './backend';
import {
    extractJson, normalize, countBySeverity, renderText, renderMarkdown, renderUnreviewedReport,
    writeArtifacts, buildRecord, readReviewedCommits, markReviewedCommits,
} from './report';
import type { ReportMeta } from './report';
import { gitCommonDir, gitHead, gitParents, gitLastAction, isAncestor, commitLabel } from './gitRun';
import { SEVERITY_ORDER } from './types';
import type { CollectResult, ReviewConfig, ReviewOutcome, ReviewScope, ReviewStatus, Severity } from './types';

/**
 * 审查引擎：收集改动 → 组提示词 → 调 codebuddy CLI → 解析 → 出报告/状态。
 *
 * 方案 B（纯插件、无钩子）下，触发来源有两类：
 *   - 「审查并提交」命令：提交前审暂存区，可拦截（scope=staged）；
 *   - 监听 HEAD 变化：提交/合并/变基/同步都已是既成事实，只做事后审查（scope=commit|merge|rebase|sync）。
 */

export interface ReviewRequest {
    repo: string;
    scope: ReviewScope;
    /** scope=commit|merge 时的目标提交 */
    rev?: string;
    /** scope=rebase|sync 时的改动前后 HEAD */
    oldHead?: string;
    newHead?: string;
    cfg: ReviewConfig;
}

/**
 * 按范围收集待审查内容
 *
 * @param reviewed 本插件已审过的提交（合并/同步场景据此去重，避免把审过的提交再审一遍）
 */
async function collectFor(req: ReviewRequest, reviewed: Set<string> = new Set()): Promise<CollectResult> {
    const { repo, cfg, scope } = req;
    if (scope === 'staged') {
        return collectStaged(repo, cfg);
    }
    if (scope === 'commit') {
        return req.rev ? collectCommit(repo, req.rev, cfg) : emptyCollect();
    }
    if (scope === 'merge') {
        return req.rev ? collectMerge(repo, req.rev, cfg, reviewed) : emptyCollect();
    }
    if (scope === 'rebase') {
        return req.oldHead && req.newHead ? collectRebase(repo, req.oldHead, req.newHead, cfg) : emptyCollect();
    }
    return req.oldHead && req.newHead ? collectSync(repo, req.oldHead, req.newHead, cfg, reviewed) : emptyCollect();
}

function emptyCollect(): CollectResult {
    return { entries: [], skipped: [], notes: [], added: 0, deleted: 0 };
}

/** 该范围下"没有内容可审"时的说明 */
function emptyReason(scope: ReviewScope): string {
    switch (scope) {
        case 'merge':
            return '本次合并没有人工解冲突改动，且带入本分支的提交都已审过或没有可审的源码改动';
        case 'rebase':
            return '变基重放的提交内容未被改写（解冲突未改动代码）';
        case 'sync':
            return '本次没有带入本分支的提交';
        default:
            return '没有可审查的源码改动（只改了非源码文件或为空）';
    }
}

/**
 * 只做「收集 + 组提示词」，不调用 AI（dry-run / 排障用）。
 * 返回的 reason 非空表示没什么可审的。
 */
export async function preparePrompt(
    req: ReviewRequest,
    reviewed: Set<string> = new Set()
): Promise<{ prompt: string; collected: CollectResult; reason: string }> {
    const collected = await collectFor(req, reviewed);
    if (collected.entries.length === 0) {
        return { prompt: '', collected, reason: emptyReason(req.scope) };
    }
    const rules = loadRules(req.repo, req.cfg.globalRulesFile);
    const prompt = buildPrompt({
        entries: collected.entries,
        scope: req.scope,
        rules,
        language: req.cfg.language,
        notes: collected.notes,
    });
    return { prompt, collected, reason: '' };
}

/** 运行一次审查 */
export async function runReview(req: ReviewRequest): Promise<ReviewOutcome> {
    const { repo, scope, cfg } = req;
    const started = Date.now();
    const stateDir = path.join(await gitCommonDir(repo), 'ai-review');
    const head = await gitHead(repo);
    const repoName = path.basename(repo);
    // 提交标签（短 sha + 主题）：commit/merge 场景填充，弹窗/报告据此自证身份
    //（多次提交的审查结果完成顺序与提交顺序可能不一致，没有标签就分不清弹窗对应哪次）
    const label = req.rev ? await commitLabel(repo, req.rev) : '';

    if (cfg.globalRulesFile) {
        ensureRulesFile(cfg.globalRulesFile);
    }

    const reviewed = readReviewedCommits(stateDir);
    const collected = await collectFor(req, reviewed);
    const meta: ReportMeta = {
        repo: repoName,
        scope,
        head: head.slice(0, 8),
        files: collected.entries.length,
        added: collected.added,
        deleted: collected.deleted,
        backend: 'codebuddy',
        elapsed: 0,
        notes: collected.notes,
    };

    // 没有可审内容：不调 AI（干净合并/干净变基都走这里）
    if (collected.entries.length === 0) {
        meta.elapsed = (Date.now() - started) / 1000;
        return finishEmpty(repo, scope, head, stateDir, meta, emptyReason(scope), collected);
    }

    const changedLines = collected.added + collected.deleted;
    if (cfg.minLines > 0 && changedLines < cfg.minLines) {
        meta.elapsed = (Date.now() - started) / 1000;
        return finishEmpty(repo, scope, head, stateDir, meta,
            `改动过小（${changedLines} 行 < 阈值 ${cfg.minLines} 行），跳过审查`, collected);
    }

    const backend = resolveBackend(cfg);
    if (!backend.available) {
        const detail = backend.detail;
        meta.backend = 'none';
        meta.elapsed = (Date.now() - started) / 1000;
        const record = buildRecord({ repo: repoName, scope, head, status: 'error', detail, meta, label });
        // 也写报告：否则 last-report.md 会停在上一次的内容上，看起来像"报告一直是老的"
        const report = renderUnreviewedReport(meta, detail, collected.entries, collected.skipped);
        const reportPath = writeArtifacts(stateDir, record, report);
        return {
            status: 'error', record, report, text: `[ai-review] ${detail}`,
            reportPath, blockingCount: 0, message: detail,
        };
    }
    meta.backend = `codebuddy(${path.basename(backend.cliPath)})`;

    const rules = loadRules(repo, cfg.globalRulesFile);
    const prompt = buildPrompt({
        entries: collected.entries,
        scope,
        rules,
        language: cfg.language,
        notes: collected.notes,
    });

    let stdout = '';
    try {
        const call = await callCli(backend.cliPath, prompt, cfg);
        stdout = call.stdout;
    } catch (e) {
        const message = (e as Error).message;
        const status: ReviewStatus = message.includes('__TIMEOUT__') ? 'timeout' : 'error';
        const detail = message.replace('__TIMEOUT__ ', '');
        meta.elapsed = (Date.now() - started) / 1000;
        const record = buildRecord({
            repo: repoName, scope, head, status, detail, meta, label,
        });
        // 超时/失败同样出报告：记录本次没审到的文件，避免打开报告看到的还是上一次的旧内容
        const report = renderUnreviewedReport(meta, detail, collected.entries, collected.skipped);
        const reportPath = writeArtifacts(stateDir, record, report);
        const text = `[ai-review] 未完成审查（${detail}）`;
        return { status, record, report, text, reportPath, blockingCount: 0, message: text };
    }

    meta.elapsed = (Date.now() - started) / 1000;
    const parsed = extractJson(stdout);
    const result = parsed ? normalize(parsed) : { summary: '', risk: '', findings: [] };
    const counts = countBySeverity(result.findings);
    const status: ReviewStatus = result.findings.length > 0 ? 'reviewed' : 'clean';

    const report = renderMarkdown(result, meta, parsed ? '' : stdout);
    const text = renderText(result, meta, parsed ? '' : stdout);
    const record = buildRecord({
        repo: repoName, scope, head, status, meta, label,
        counts,
        risk: result.risk,
        summary: result.summary,
        detail: parsed ? '' : '模型未返回可解析的 JSON（原始输出见报告）',
    });
    const reportPath = writeArtifacts(stateDir, record, report);
    // 真正审完（不论有没有问题）才记入"已审"，超时/失败的下次还会再审
    if (collected.commits && collected.commits.length > 0) {
        markReviewedCommits(stateDir, collected.commits);
    }

    const blockingCount = result.findings
        .filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER[cfg.blockAt]).length;
    const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
    const message = result.findings.length > 0
        ? `发现 ${result.findings.length} 个问题（${countText}）`
        : '未发现问题';

    return { status, record, result, report, text, reportPath, blockingCount, message };
}

/** 无需审查/无法审查时统一收尾（仍写状态，避免"看起来审过"） */
function finishEmpty(
    repo: string,
    scope: ReviewScope,
    head: string,
    stateDir: string,
    meta: ReportMeta,
    reason: string,
    collected: CollectResult
): ReviewOutcome {
    const record = buildRecord({
        repo: path.basename(repo), scope, head, status: 'skipped', detail: reason, meta,
    });
    const report = renderUnreviewedReport(meta, reason, collected.entries, collected.skipped);
    const reportPath = writeArtifacts(stateDir, record, report);
    const text = `[ai-review] ${reason}`;
    return { status: 'skipped', record, report, text, reportPath, blockingCount: 0, message: reason };
}

// ---------------------------------------------------------------------------
// HEAD 变化分类（方案 B：事后判定发生了什么操作）
// ---------------------------------------------------------------------------

export interface HeadChange {
    /** 需要审查的范围；none = 不是新的提交事件 */
    scope: ReviewScope | 'none';
    /** commit/merge 场景的目标提交 */
    rev?: string;
    /** 展示用说明 */
    detail: string;
}

/**
 * 判断 HEAD 从 oldHead 变成 newHead 属于什么操作。
 *
 * 依据（每条都可解释、可测）：
 *   - reflog 的动作描述是第一信号：checkout/reset/clone 只是切分支或回退，不是新提交；
 *   - 合并提交（≥2 个父）→ merge；
 *   - 单父且父正好是旧 HEAD → 普通提交（也覆盖 cherry-pick）；
 *   - reflog 说 amend → 按普通提交审这次修订的内容；
 *   - 旧 HEAD 是新 HEAD 的祖先但差多个提交 → 快进/拉取 → sync；
 *   - 旧 HEAD 不是新 HEAD 的祖先且 reflog 说 rebase → 变基。
 */
export async function classifyHeadChange(
    repo: string,
    oldHead: string,
    newHead: string,
    action: string
): Promise<HeadChange> {
    if (!newHead || !oldHead || newHead === oldHead) {
        return { scope: 'none', detail: 'HEAD 未变化' };
    }
    const verb = action.split(':')[0].trim().toLowerCase();
    if (verb.startsWith('checkout') || verb.startsWith('reset') || verb.startsWith('clone')) {
        return { scope: 'none', detail: `HEAD 变化来自 ${verb}（不是新的提交）` };
    }

    const parents = await gitParents(repo, newHead);
    if (parents.length >= 2) {
        return { scope: 'merge', rev: newHead, detail: '检测到合并提交' };
    }
    if (parents.length === 1 && parents[0] === oldHead) {
        const label = await commitLabel(repo, newHead);
        return { scope: 'commit', rev: newHead, detail: `检测到新提交：${label}` };
    }
    if (action.toLowerCase().includes('amend')) {
        const label = await commitLabel(repo, newHead);
        return { scope: 'commit', rev: newHead, detail: `检测到提交修订（amend）：${label}` };
    }
    if (await isAncestor(repo, oldHead, newHead)) {
        return { scope: 'sync', detail: '检测到快进/拉取（带入新提交）' };
    }
    if (verb.startsWith('rebase') || action.toLowerCase().includes('rebase')) {
        return { scope: 'rebase', detail: '检测到变基' };
    }
    return { scope: 'none', detail: `无法判定的 HEAD 变化（reflog: ${action || '未知'}）` };
}

/** 读取 reflog 的最近动作（供调用方与分类一起用） */
export async function lastAction(repo: string): Promise<string> {
    return gitLastAction(repo);
}

/** 供 UI 展示的严重级别说明 */
export function describeBlocking(count: number, blockAt: Severity): string {
    return count > 0 ? `有 ${count} 个 ${blockAt} 及以上级别的问题` : '没有达到拦截级别的问题';
}
