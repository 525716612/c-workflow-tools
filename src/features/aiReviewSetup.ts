import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { findGitRoot } from '../utils/git';
import { resolveBackend } from '../aiReview/backend';
import { DEFAULT_REVIEW_RULES } from '../aiReview/rules';
import { defaultConfig } from '../aiReview/types';
import type { ReviewConfig, Severity } from '../aiReview/types';
import { log, logError } from '../outputChannel';

/**
 * AI 审查的「配置 + 启动闸门」。
 *
 * 方案 B：审查全部由插件完成，外部只依赖 `codebuddy` CLI。
 * 启动条件（都满足才启动，且不产生其它副作用）：
 *   1. 工作区里有 git 仓库；
 *   2. 能找到 codebuddy CLI。
 * 不满足时只写一行日志，不监听、不弹窗、不写任何文件 —— 插件可能被别人安装。
 *
 * 另外本文件负责识别**旧的 Python 版钩子环境**（~/.git-hooks + 全局 core.hooksPath），
 * 它仍在生效时会和插件重复审查，因此提供一键清理。
 */

export const AI_REVIEW_STATUS_COMMAND = 'c-workflow-tools.aiReviewStatus';
export const AI_REVIEW_CLEAN_LEGACY_COMMAND = 'c-workflow-tools.aiReviewCleanLegacy';

/** 旧版 Python 钩子的识别标志文件 */
const LEGACY_MARKER = 'ai_review.py';

/** 从 VS Code 设置映射出引擎配置 */
export function readConfig(context: vscode.ExtensionContext): ReviewConfig {
    const cfg = defaultConfig();
    const get = <T>(key: string, fallback: T): T =>
        vscode.workspace.getConfiguration('c-workflow-tools').get<T>(key, fallback);

    cfg.cliPath = get('aiReview.cliPath', '');
    cfg.timeoutSec = get('aiReview.timeoutSec', cfg.timeoutSec);
    cfg.maxFiles = get('aiReview.maxFiles', cfg.maxFiles);
    cfg.maxDiffKb = get('aiReview.maxDiffKb', cfg.maxDiffKb);
    cfg.maxFileLines = get('aiReview.maxFileLines', cfg.maxFileLines);
    cfg.minLines = get('aiReview.minLines', cfg.minLines);
    cfg.maxCommits = get('aiReview.maxCommits', cfg.maxCommits);
    cfg.language = get('aiReview.language', cfg.language) === 'en' ? 'en' : 'zh';
    cfg.blockAt = get<Severity>('aiReview.blockAt', cfg.blockAt);
    cfg.globalRulesFile = path.join(context.globalStorageUri.fsPath, 'review-rules.md');
    return cfg;
}

/** 工作区里所有 git 仓库根目录（去重） */
export function workspaceRepos(): string[] {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const root = findGitRoot(folder.uri.fsPath);
        if (root) {
            roots.add(root);
        }
    }
    return [...roots];
}

/** 启动闸门结果 */
export interface GateResult {
    enabled: boolean;
    /** 未启用时的原因 */
    reason: string;
    /** 找到的 codebuddy CLI 路径 */
    cliPath: string;
    repos: string[];
    cfg: ReviewConfig;
}

/** 评估启动条件：git 仓库 + codebuddy CLI 都满足才启用 */
export function evaluateGate(context: vscode.ExtensionContext): GateResult {
    const cfg = readConfig(context);
    const repos = workspaceRepos();
    if (!vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>('aiReview.enabled', true)) {
        return { enabled: false, reason: '设置项 c-workflow-tools.aiReview.enabled 已关闭', cliPath: '', repos, cfg };
    }
    if (repos.length === 0) {
        return { enabled: false, reason: '当前工作区没有 git 仓库', cliPath: '', repos, cfg };
    }
    const backend = resolveBackend(cfg);
    if (!backend.available) {
        return { enabled: false, reason: backend.detail, cliPath: '', repos, cfg };
    }
    return { enabled: true, reason: '', cliPath: backend.cliPath, repos, cfg };
}

// ---------------------------------------------------------------------------
// 旧环境（Python 版全局钩子）
// ---------------------------------------------------------------------------

/** 读取全局 core.hooksPath */
function globalHooksPath(): string {
    try {
        const out = require('child_process').execSync('git config --global --get core.hooksPath', {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }) as string;
        return out.trim();
    } catch {
        return '';
    }
}

/** 旧版 Python 钩子目录（存在且包含 ai_review.py 才算） */
export function legacyHooksDir(): string {
    const dir = globalHooksPath();
    if (!dir) {
        return '';
    }
    try {
        return fs.existsSync(path.join(dir, LEGACY_MARKER)) ? dir : '';
    } catch {
        return '';
    }
}

/** 执行 git 命令（清理旧配置用） */
function runGitCommand(args: string[], cwd: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        execFile('git', args, { cwd, windowsHide: true }, (err, stdout) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(String(stdout));
        });
    });
}

/**
 * 清理旧环境：取消全局 core.hooksPath，让旧 Python 钩子不再随提交运行。
 * 只改 git 配置，不删除任何文件（目录要不要删由用户自己决定）。
 */
export async function cleanLegacyEnvironment(): Promise<void> {
    const dir = legacyHooksDir();
    if (!dir) {
        vscode.window.showInformationMessage('未检测到旧的 AI 审查钩子环境（全局 core.hooksPath 未指向带 ai_review.py 的目录）。');
        return;
    }
    const pick = await vscode.window.showWarningMessage(
        '清理旧的 AI 审查钩子环境？',
        {
            modal: true,
            detail: [
                `将执行：git config --global --unset core.hooksPath`,
                `当前指向：${dir}`,
                '',
                '作用：旧的 Python 钩子不再随 git 操作运行，避免与插件重复审查、重复弹窗。',
                '不会删除任何文件（目录可自行删除）；如需恢复，重新设置 core.hooksPath 即可。',
            ].join('\n'),
        },
        '清理'
    );
    if (pick !== '清理') {
        return;
    }
    try {
        const repo = workspaceRepos()[0] ?? process.cwd();
        await runGitCommand(['config', '--global', '--unset', 'core.hooksPath'], repo);
        log(`已取消全局 core.hooksPath（原值 ${dir}）`);
        vscode.window.showInformationMessage('已清理：旧钩子不再生效。目录 ' + dir + ' 可自行删除。');
    } catch (e) {
        const message = (e as Error).message;
        logError(`清理旧环境失败：${message}`);
        vscode.window.showErrorMessage(`清理失败：${message}`);
    }
}

// ---------------------------------------------------------------------------
// 状态命令
// ---------------------------------------------------------------------------

/**
 * 命令：查看 AI 审查的启动条件与本机配置。
 * 面板里写完整信息，同时弹一条简短结论。
 */
export async function showAiReviewStatus(context: vscode.ExtensionContext): Promise<void> {
    const gate = evaluateGate(context);
    const legacy = legacyHooksDir();
    const lines: string[] = [];

    lines.push(`启动条件：${gate.enabled ? '满足（审查功能已就绪）' : `不满足 — ${gate.reason}`}`);
    lines.push(`codebuddy CLI：${gate.cliPath || '未找到'}`);
    if (gate.cfg.cliPath) {
        lines.push(`   （按设置指定：${gate.cfg.cliPath}）`);
    }
    lines.push(`工作区 git 仓库：${gate.repos.length > 0 ? gate.repos.map((r) => path.basename(r)).join(', ') : '（无）'}`);
    lines.push(`审查开关：提交=${onOff('aiReview.reviewCommit')} 合并=${onOff('aiReview.reviewMerge')}`
        + ` 变基=${onOff('aiReview.reviewRebase')} 同步=${onOff('aiReview.reviewSync')}`);
    lines.push(`拦截级别：「审查并提交」在 ${gate.cfg.blockAt} 及以上问题时会先确认；事后审查只能报告`);
    lines.push(`超时/上限：${gate.cfg.timeoutSec}s，最多 ${gate.cfg.maxFiles} 文件 / ${gate.cfg.maxDiffKb}KB`);
    lines.push(`规则文件：${gate.cfg.globalRulesFile ?? '（未设置）'}（仓库级 .ai-review-rules.md 自动追加）`);
    if (legacy) {
        lines.push('');
        lines.push(`⚠ 检测到旧的 Python 钩子环境仍在生效：${legacy}`);
        lines.push('   它与本插件会各审一遍（重复审查、重复弹窗），建议执行「清理旧环境」命令。');
    }

    const detail = lines.join('\n');
    log(`=== AI 审查状态 ===\n${detail}`);

    const buttons: string[] = [];
    if (legacy) {
        buttons.push('清理旧环境');
    }
    if (gate.cfg.globalRulesFile) {
        buttons.push('编辑全局规则');
    }
    const pick = await vscode.window.showInformationMessage(
        gate.enabled ? 'AI 审查（插件内置引擎）：已就绪' : `AI 审查未启用：${gate.reason}`,
        { detail },
        ...buttons
    );
    if (pick === '清理旧环境') {
        await cleanLegacyEnvironment();
    } else if (pick === '编辑全局规则' && gate.cfg.globalRulesFile) {
        const file = gate.cfg.globalRulesFile;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            if (!fs.existsSync(file)) {
                fs.writeFileSync(file, `# 全局审查规则（本机所有仓库生效，优先级高于内置默认）\n\n${DEFAULT_REVIEW_RULES}\n`, 'utf8');
            }
            await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: true });
        } catch (e) {
            logError(`打开规则文件失败：${(e as Error).message}`);
        }
    }
}

/** 读取设置里的布尔开关（用于状态展示） */
function onOff(key: string): string {
    return vscode.workspace.getConfiguration('c-workflow-tools').get<boolean>(key, true) ? '开' : '关';
}

/**
 * 首次发现旧环境时提示一次（避免用户不知道有重复审查）。
 * 记在 globalState 里，用户选择忽略后不再打扰。
 */
export async function promptLegacyCleanupOnce(context: vscode.ExtensionContext): Promise<void> {
    const dir = legacyHooksDir();
    if (!dir) {
        return;
    }
    const key = 'aiReview.legacyPromptShown';
    if (context.globalState.get<boolean>(key, false)) {
        return;
    }
    await context.globalState.update(key, true);
    const pick = await vscode.window.showWarningMessage(
        '检测到旧的 AI 审查钩子仍在运行，会与插件重复审查',
        {
            modal: false,
            detail: `旧钩子目录：${dir}\n执行「清理旧环境」可让插件独占地负责审查（只改 git 配置，不删文件）。`,
        },
        '清理旧环境',
        '稍后'
    );
    if (pick === '清理旧环境') {
        await cleanLegacyEnvironment();
    }
}
