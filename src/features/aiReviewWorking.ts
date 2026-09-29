import * as vscode from 'vscode';
import * as path from 'path';
import { evaluateGate } from './aiReviewSetup';
import { runReview } from '../aiReview/engine';
import { showOutcomeNotification } from './aiReviewWatch';
import { getGitWorkingDir, findGitRoot } from '../utils/git';
import type { ReviewOutcome } from '../aiReview/types';
import { log } from '../outputChannel';

export const AI_REVIEW_WORKING_COMMAND = 'c-workflow-tools.aiReviewWorking';

/**
 * 解析要审查的仓库：优先显式给定路径（工具入参），否则用当前文件/工作区所在仓库。
 */
export function resolveReviewRepo(explicit?: string): string | undefined {
    if (explicit && explicit.trim()) {
        return findGitRoot(explicit.trim());
    }
    return getGitWorkingDir();
}

/**
 * 审查工作区未提交改动（相对 HEAD，含已暂存与未暂存），只返回结果、不弹窗也不提交。
 * 供命令与语言模型工具复用。
 */
export async function runWorkingReview(
    context: vscode.ExtensionContext,
    repo: string,
): Promise<ReviewOutcome> {
    const gate = evaluateGate(context);
    return runReview({ repo, scope: 'working', cfg: gate.cfg });
}

/**
 * 命令「AI 审查未提交改动」：改完还没提交时先审一遍（不提交、不改动文件）。
 */
export async function reviewWorkingTree(context: vscode.ExtensionContext): Promise<void> {
    const gate = evaluateGate(context);
    if (!gate.enabled) {
        vscode.window.showWarningMessage(`AI 审查未启用：${gate.reason}`);
        return;
    }
    const repo = resolveReviewRepo();
    if (!repo) {
        vscode.window.showWarningMessage('没有找到 git 仓库（请打开仓库内文件后重试）');
        return;
    }
    log(`AI 审查未提交改动：${path.basename(repo)}（审查 git diff HEAD）`);
    const outcome = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'AI 正在审查工作区未提交改动…',
            cancellable: false,
        },
        () => runReview({ repo, scope: 'working', cfg: gate.cfg })
    );
    log(`AI 审查未提交改动：${outcome.record.status_text}（${outcome.message}）`);
    await showOutcomeNotification(outcome);
}