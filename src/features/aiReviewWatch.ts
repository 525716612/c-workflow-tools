import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { evaluateGate } from './aiReviewSetup';
import { gitLastAction, runGitQuiet, gitHead, gitCommonDir } from '../aiReview/gitRun';
import { classifyHeadChange, runReview } from '../aiReview/engine';
import type { ReviewOutcome, ReviewScope } from '../aiReview/types';
import { log, logError } from '../outputChannel';

/**
 * 方案 B 的触发端：监听 HEAD 变化，事后审查提交/合并/变基/同步。
 *
 * 为什么是"事后"：没有 git 钩子，提交早已产生，拦截不可能；这里只负责发现问题并提示。
 * 唯一能拦截的是「审查并提交」命令（见 aiReviewCommit.ts）——那才是提交前。
 *
 * 判定范围交给引擎的 classifyHeadChange（依据 reflog 动作 + 提交父子关系），
 * 干净合并/干净变基不会有任何 AI 调用。
 */

/** HEAD 轮询间隔：git rev-parse 很便宜，2 秒足够及时 */
const POLL_INTERVAL_MS = 2000;

/** 「审查并提交」已经审过的提交，避免提交后再被事后审一遍 */
const reviewedHeads = new Map<string, string>();

/** 标记某个提交已审查（供「审查并提交」调用） */
export function markHeadReviewed(repo: string, sha: string): void {
    if (sha) {
        reviewedHeads.set(repo, sha);
    }
}

/** 该范围是否被设置开启 */
function scopeEnabled(scope: ReviewScope | 'none'): boolean {
    const get = (key: string, fallback: boolean): boolean =>
        vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>(key, fallback);
    switch (scope) {
        case 'commit': return get('aiReview.reviewCommit', true);
        case 'merge': return get('aiReview.reviewMerge', true);
        case 'rebase': return get('aiReview.reviewRebase', true);
        case 'sync': return get('aiReview.reviewSync', true);
        default: return false;
    }
}

/**
 * 注册 HEAD 监听。启动条件不满足时什么都不做（不监听、不写文件）。
 */
export function registerAiReviewWatch(context: vscode.ExtensionContext): void {
    let timer: NodeJS.Timeout | undefined;
    /** 代数：refresh 期间又发生变更时，旧的一次作废（避免定时器叠加/泄漏） */
    let generation = 0;
    const repos = new Set<string>();
    const heads = new Map<string, string>();
    const busy = new Set<string>();
    /** 审查期间又发生了提交：等这次审完再处理最新的一次 */
    const pending = new Map<string, { from: string; to: string }>();

    const stop = (): void => {
        generation++;
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        repos.clear();
        heads.clear();
        busy.clear();
        pending.clear();
    };

    const onHeadChanged = async (repo: string, from: string, to: string): Promise<void> => {
        if (busy.has(repo)) {
            pending.set(repo, { from, to });
            return;
        }
        busy.add(repo);
        try {
            const action = await gitLastAction(repo);
            const change = await classifyHeadChange(repo, from, to, action);
            if (change.scope === 'none') {
                log(`AI 审查：${path.basename(repo)} ${change.detail}`);
                return;
            }
            if (!scopeEnabled(change.scope)) {
                log(`AI 审查：${path.basename(repo)} ${change.detail}，但该范围已在设置中关闭，跳过`);
                return;
            }
            log(`AI 审查：${path.basename(repo)} ${change.detail} → 开始审查（scope=${change.scope}）`);
            const gate = evaluateGate(context);
            const scope = change.scope; // 提前收窄类型：闭包里属性收窄会失效
            // 审查全程给个进度提示：CLI 一跑可能几分钟，没有提示的话结果就像"突然"弹出来的
            const outcome = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: `C Workflow：AI 正在审查 ${path.basename(repo)} 的`
                        + `${SCOPE_TEXT[scope] ?? scope}改动…`,
                    cancellable: false,
                },
                () => runReview({
                    repo,
                    scope,
                    rev: change.rev,
                    oldHead: from,
                    newHead: to,
                    cfg: gate.cfg,
                })
            );
            log(`AI 审查：${path.basename(repo)} ${outcome.record.status_text}（${outcome.message}）`);
            await showOutcomeNotification(outcome);
        } catch (e) {
            logError(`事后审查失败（${path.basename(repo)}）：${(e as Error).message}`);
        } finally {
            busy.delete(repo);
            const next = pending.get(repo);
            pending.delete(repo);
            if (next && next.to !== to) {
                void onHeadChanged(repo, next.from, next.to);
            }
        }
    };

    const tick = async (repo: string): Promise<void> => {
        const head = await gitHead(repo);
        if (!head || head === heads.get(repo)) {
            return;
        }
        const previous = heads.get(repo) ?? '';
        heads.set(repo, head);
        if (reviewedHeads.get(repo) === head) {
            return; // 刚刚由「审查并提交」审过
        }
        if (!previous) {
            return; // 首次记录基线，不审历史
        }
        await onHeadChanged(repo, previous, head);
    };

    const refresh = async (): Promise<void> => {
        stop();
        const gen = generation;
        const gate = evaluateGate(context);
        if (!gate.enabled) {
            log(`AI 审查未启动：${gate.reason}`);
            return;
        }
        if (gen !== generation) {
            return;
        }
        for (const repo of gate.repos) {
            repos.add(repo);
            heads.set(repo, await gitHead(repo));
        }
        if (gen !== generation) {
            return;
        }
        log(`AI 审查已启用（引擎=插件内置，后端=${path.basename(gate.cliPath)}）：`
            + `监听 ${gate.repos.length} 个仓库，提交/合并/变基/同步后自动审查`);
        timer = setInterval(() => {
            for (const repo of repos) {
                tick(repo).catch((e: Error) => logError(`AI 审查轮询失败：${e.message}`));
            }
        }, POLL_INTERVAL_MS);
    };

    void refresh().catch((e: Error) => logError(`AI 审查启动失败：${e.message}`));

    context.subscriptions.push(
        new vscode.Disposable(stop),
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void refresh().catch((e: Error) => logError(`AI 审查重启失败：${e.message}`));
        }),
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('c-workflow-tools.aiReview')) {
                void refresh().catch((err: Error) => logError(`AI 审查重启失败：${err.message}`));
            }
        })
    );
}

/** 审查范围的中文说明（结果弹窗展示用）；覆盖全部 ReviewScope，索引必命中 */
const SCOPE_TEXT: Record<ReviewScope, string> = {
    staged: '本地提交（提交前）',
    commit: '本地提交',
    merge: '合并',
    rebase: '变基',
    sync: '同步带入',
};

/**
 * 弹出审查结果通知（附「打开报告」）。
 * 只有"发现问题"（reviewed）才按 modalResult 决定模态/非模态；
 * 超时/失败（timeout/error）一律右下角通知 —— 审查没做成不值得打断当前操作。
 */
export async function showOutcomeNotification(outcome: ReviewOutcome): Promise<void> {
    const record = outcome.record;
    if (record.status === 'skipped') {
        return; // 无需审查的情况不打扰
    }
    if (!vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>('aiReview.notify', true)) {
        log(`AI 审查结果（未弹窗提示）：${outcome.message}`);
        return;
    }
    const counts = record.counts ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    // reviewed 本身意味着"发现问题"（engine 侧 findings 为空时状态是 clean），
    // total>0 是显式兜底：确保模态框只出现在真正有问题时，与注释/配置描述语义一致
    const modal = record.status === 'reviewed' && total > 0
        && vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>('aiReview.modalResult', true);
    const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');

    let message: string;
    let severity: 'info' | 'warning' | 'error' = 'info';
    if (record.status === 'reviewed') {
        severity = counts.high ? 'error' : 'warning';
        message = `AI 审查：发现 ${total} 个问题（${countText || '见报告'}）`;
    } else if (record.status === 'clean') {
        message = 'AI 审查：未发现问题';
    } else {
        severity = 'warning';
        message = `AI 审查未完成（${record.status === 'timeout' ? '调用超时' : '调用失败'}）：本次改动未被审查`;
    }

    const detail = [
        record.summary ? `结论：${record.summary}` : '',
        record.detail ? `说明：${record.detail}` : '',
        '',
        `仓库：${record.repo}    范围：${SCOPE_TEXT[record.scope] ?? record.scope}    文件：${record.files}`
            + `（+${record.added} -${record.deleted}）`,
        record.risk ? `风险：${record.risk}` : '',
    ].filter((line) => line !== '').join('\n');

    const options: vscode.MessageOptions = { detail, modal };
    const open = '打开报告';
    let pick: string | undefined;
    if (severity === 'error') {
        pick = await vscode.window.showErrorMessage(message, options, open);
    } else if (severity === 'warning') {
        pick = await vscode.window.showWarningMessage(message, options, open);
    } else {
        pick = await vscode.window.showInformationMessage(message, options, open);
    }
    if (pick === open) {
        await openReport(outcome);
    }
}

/** 打开审查报告（Markdown 预览，失败退回普通文本） */
export async function openReport(outcome: ReviewOutcome): Promise<void> {
    const reportPath = outcome.reportPath;
    if (!reportPath || !fs.existsSync(reportPath)) {
        const stateDir = path.dirname(reportPath || '');
        if (!stateDir || !fs.existsSync(path.join(stateDir, 'last-report.md'))) {
            vscode.window.showWarningMessage('没有找到审查报告文件');
            return;
        }
    }
    const uri = vscode.Uri.file(reportPath);
    try {
        await vscode.commands.executeCommand('markdown.showPreview', uri);
    } catch {
        await vscode.window.showTextDocument(uri, { preview: true });
    }
}

/** 供「审查并提交」复用：某个仓库当前 HEAD（提交后标记用） */
export async function currentHead(repo: string): Promise<string> {
    return gitHead(repo);
}

/** 供「审查并提交」复用：暂存区是否有改动 */
export async function hasStagedChanges(repo: string): Promise<boolean> {
    const raw = await runGitQuiet(['diff', '--cached', '--name-only'], repo, 30000);
    return raw.trim() !== '';
}

/** 供「审查并提交」复用：git 目录（状态文件位置） */
export async function stateDirOf(repo: string): Promise<string> {
    return path.join(await gitCommonDir(repo), 'ai-review');
}
