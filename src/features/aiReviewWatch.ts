import * as vscode from 'vscode';
import * as path from 'path';
import { evaluateGate } from './aiReviewSetup';
import { gitLastAction, runGitQuiet, gitHead, gitCommonDir } from '../aiReview/gitRun';
import { classifyHeadChange, runReview } from '../aiReview/engine';
import { resolveOpenableReportPath } from '../aiReview/report';
import type { ReviewOutcome, ReviewScope, ReviewStatusRecord } from '../aiReview/types';
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
    /**
     * 审查期间又发生的 HEAD 变化：**逐个排队**，按顺序审查。
     * 不能只保留"最新的一次"——短时间连续提交时，中间提交会被后一次覆盖而永久漏审，
     * 表现为"第二次提交的审查弹窗显示的仍是第一次提交"。
     */
    const pending = new Map<string, Array<{ from: string; to: string }>>();

    // 审查期间的状态栏常驻指示：右下角进度通知忙起来容易忽略，状态栏始终可见，
    // 显示「AI 审查中 · 仓库名 · 已耗时」，避免用户忘记有审查在跑、结果弹窗显得"突然"
    const reviewStarts = new Map<string, number>();
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBar.name = 'C Workflow AI 审查';
    const statusTimer = setInterval(() => {
        if (reviewStarts.size === 0) {
            statusBar.hide();
            return;
        }
        const parts = [...reviewStarts.entries()]
            .map(([r, t]) => {
                const queued = pending.get(r)?.length ?? 0;
                return `${path.basename(r)} ${Math.floor((Date.now() - t) / 1000)}s`
                    + (queued > 0 ? `（另有 ${queued} 次提交排队）` : '');
            });
        statusBar.text = `$(sync~spin) AI 审查中 · ${parts.join(' · ')}`;
        statusBar.tooltip = 'AI 代码审查正在后台运行，结束后会弹出结果；'
            + '「排队」表示后面还有提交在等待审查，当前弹窗对应的是更早的那次提交';
        statusBar.show();
    }, 1000);
    context.subscriptions.push(statusBar);

    const stop = (): void => {
        generation++;
        if (timer) {
            clearInterval(timer);
            timer = undefined;
        }
        clearInterval(statusTimer);
        reviewStarts.clear();
        statusBar.hide();
        repos.clear();
        heads.clear();
        busy.clear();
        pending.clear();
    };

    const onHeadChanged = async (repo: string, from: string, to: string): Promise<void> => {
        if (busy.has(repo)) {
            const queue = pending.get(repo) ?? [];
            const last = queue[queue.length - 1];
            if (!last || last.to !== to) {
                queue.push({ from, to });
                pending.set(repo, queue);
                log(`AI 审查：${path.basename(repo)} 检测到新 HEAD ${to.slice(0, 8)}，`
                    + `当前提交仍在审查，已排队（队列 ${queue.length}）`);
            }
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
            reviewStarts.set(repo, Date.now()); // 状态栏指示开始计时（无审查时隐藏）
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
            reviewStarts.delete(repo);
            // 队列里还有等待审查的 HEAD 变化：立刻接着审下一个（逐个审查，不丢提交）
            const queue = pending.get(repo) ?? [];
            const next = queue.shift();
            if (queue.length === 0) {
                pending.delete(repo);
            } else {
                pending.set(repo, queue);
            }
            if (reviewStarts.size === 0 && !next) {
                statusBar.hide();
            }
            if (next) {
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
        }),
        // 窗口重新聚焦时，把后台（最小化/失焦）期间完成、只做了非模态提示的结果重新弹出
        vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                void flushMissedOutcomes().catch((e: Error) => logError(`重弹审查结果失败：${e.message}`));
            }
        })
    );
}

/** 审查范围的中文说明（结果弹窗展示用）；覆盖全部 ReviewScope，索引必命中 */
const SCOPE_TEXT: Record<ReviewScope, string> = {
    staged: '本地提交（提交前）',
    working: '未提交改动（工作区）',
    commit: '本地提交',
    merge: '合并',
    rebase: '变基',
    sync: '同步带入',
};

/**
 * 窗口不在前台（最小化/切走）期间完成的审查结果，聚焦后重新弹出。
 * 只登记"审出问题"（reviewed 且有 findings）的结果；超时/失败/无问题已用非模态留痕，不再重弹。
 */
const missedWhileUnfocused: ReviewOutcome[] = [];

/** 失焦期间暂存、待聚焦后重弹的结果上限（避免积压一堆模态框打断操作） */
const MAX_MISSED = 3;

/** 是否审出了问题（reviewed 且有 findings）——登记重弹只看这个，与"是否用模态"解耦 */
function hasProblems(record: ReviewStatusRecord): boolean {
    const total = Object.values(record.counts ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
    return record.status === 'reviewed' && total > 0;
}

/** 该结果是否会用模态弹出（有问题且启用 modalResult） */
function isModalWorthy(record: ReviewStatusRecord): boolean {
    return hasProblems(record)
        && vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>('aiReview.modalResult', true);
}

/**
 * 弹出审查结果通知（附「打开报告」）。
 * 只有"发现问题"（reviewed）才按 modalResult 决定模态/非模态；
 * 超时/失败（timeout/error）一律右下角通知 —— 审查没做成不值得打断当前操作。
 *
 * 窗口不在前台（最小化/失焦）时**强制非模态**：模态框此时会被漏看，而非模态会进
 * 通知中心（铃铛/任务栏徽标）留下痕迹；只有"发现问题"的结果才登记，聚焦后再正式弹出。
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
    if (!vscode.window.state.focused) {
        // 先同步登记（不依赖 await）：非模态通知要等用户关闭才 settle，晚登记会漏掉重弹。
        // 每个 outcome 只会投递一次，无需按引用去重
        if (hasProblems(record)) {
            missedWhileUnfocused.push(outcome);
            if (missedWhileUnfocused.length > MAX_MISSED) {
                const dropped = missedWhileUnfocused.splice(0, missedWhileUnfocused.length - MAX_MISSED);
                log(`AI 审查：后台积压结果超过 ${MAX_MISSED} 条，折叠较早的 ${dropped.length} 条（均已在通知中心留痕）`);
            }
        }
        log(`AI 审查结果（窗口不在前台，先非模态提示）：${outcome.message}`);
        await presentOutcome(outcome, false);
        return;
    }
    await presentOutcome(outcome, true);
}

/** 窗口重新聚焦时把后台登记的结果逐条重弹；中途用户又切走则保留剩余项，等下次聚焦 */
let flushingMissed = false;
export async function flushMissedOutcomes(): Promise<void> {
    if (flushingMissed) {
        return; // 已有一次在跑：避免切走再切回时并发弹多个模态
    }
    flushingMissed = true;
    try {
        while (missedWhileUnfocused.length > 0) {
            if (!vscode.window.state.focused) {
                return; // 用户又切走了，剩余项留到下次聚焦
            }
            const outcome = missedWhileUnfocused.shift();
            if (outcome) {
                await presentOutcome(outcome, true);
            }
        }
    } finally {
        flushingMissed = false;
    }
}

/** 实际呈现一条结果；allowModal=false 时强制非模态（后台/最小化时用） */
async function presentOutcome(outcome: ReviewOutcome, allowModal: boolean): Promise<void> {
    const record = outcome.record;
    const counts = record.counts ?? {};
    const total = Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
    // 模态判定与 isModalWorthy 共用同一口径，避免"登记了却不弹/弹了却不登记"
    const modal = allowModal && isModalWorthy(record);
    const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');

    // 弹窗标题自证身份：审查完成顺序与提交顺序可能不一致（耗时不同/多仓库并行），
    // 没有仓库+范围+提交标签就分不清结果对应哪次改动
    const scopeText = SCOPE_TEXT[record.scope] ?? record.scope;
    const ctx = [record.repo, scopeText, record.label || record.head].filter(Boolean).join(' · ');

    let message: string;
    let severity: 'info' | 'warning' | 'error' = 'info';
    if (record.status === 'reviewed') {
        severity = counts.high ? 'error' : 'warning';
        message = `AI 审查【${ctx}】：发现 ${total} 个问题（${countText || '见报告'}）`;
    } else if (record.status === 'clean') {
        message = `AI 审查【${ctx}】：未发现问题`;
    } else {
        severity = 'warning';
        message = `AI 审查未完成【${ctx}】（${record.status === 'timeout' ? '调用超时' : '调用失败'}）：本次改动未被审查`;
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
    // 首选本次审查的报告快照；缺失时回退到「最新报告」last-report.md
    const reportPath = resolveOpenableReportPath(outcome.reportPath);
    if (!reportPath) {
        vscode.window.showWarningMessage('没有找到审查报告文件');
        return;
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
