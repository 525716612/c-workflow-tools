import * as vscode from 'vscode';
import * as path from 'path';
import { evaluateGate } from './aiReviewSetup';
import { runReview } from '../aiReview/engine';
import { runGit } from '../aiReview/gitRun';
import {
    showOutcomeNotification, markHeadReviewed, currentHead, hasStagedChanges,
} from './aiReviewWatch';
import { getGitWorkingDir } from '../utils/git';
import { log, logError } from '../outputChannel';

/**
 * 「AI 审查并提交」：方案 B 下唯一能**拦截**本地提交的入口。
 *
 * 流程：审暂存区（提交前）→ 有问题先弹结果并要求确认 → 填提交信息 → git commit。
 * 合并/变基/同步无法拦截（那些操作本身已经把提交造出来了），只由 HEAD 监听做事后审查。
 *
 * 说明：这个命令只覆盖"走本命令提交"的场景。如果你在 VS Code 源代码管理面板或终端里
 * 直接 git commit，插件会在提交后审查并提示（事后，不能拦截）。
 */
export async function reviewAndCommit(context: vscode.ExtensionContext): Promise<void> {
    const gate = evaluateGate(context);
    if (!gate.enabled) {
        vscode.window.showWarningMessage(`AI 审查未启用：${gate.reason}`);
        return;
    }
    const repo = getGitWorkingDir();
    if (!repo) {
        vscode.window.showWarningMessage('没有找到 git 仓库（请打开仓库内文件后重试）');
        return;
    }
    if (!(await hasStagedChanges(repo))) {
        vscode.window.showWarningMessage('暂存区没有改动，请先 git add 需要提交的文件');
        return;
    }

    log(`AI 审查并提交：${path.basename(repo)}（审查暂存区）`);
    const outcome = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'AI 正在审查暂存区改动…',
            cancellable: false,
        },
        () => runReview({ repo, scope: 'staged', cfg: gate.cfg })
    );
    log(`AI 审查并提交：${outcome.record.status_text}（${outcome.message}）`);

    if (outcome.status === 'reviewed') {
        await showOutcomeNotification(outcome);
        if (outcome.blockingCount > 0) {
            const pick = await vscode.window.showWarningMessage(
                `发现 ${outcome.blockingCount} 个 ${gate.cfg.blockAt} 及以上级别的问题，仍要提交吗？`,
                { modal: true, detail: outcome.record.summary || outcome.message },
                '仍然提交'
            );
            if (pick !== '仍然提交') {
                log('用户选择取消提交（可先修复问题或用 --no-verify 之外的其它方式提交）');
                return;
            }
        }
    } else if (outcome.status === 'clean') {
        // 通过，继续
    } else if (outcome.status === 'skipped') {
        const pick = await vscode.window.showInformationMessage(
            `本次无需审查（${outcome.message}），继续提交？`, { modal: false }, '继续提交', '取消');
        if (pick !== '继续提交') {
            return;
        }
    } else {
        // timeout / error：审查没做成，让用户决定是否照常提交
        const pick = await vscode.window.showWarningMessage(
            `AI 审查未完成（${outcome.record.detail || outcome.record.status}）`,
            { modal: true, detail: '本次改动未被审查。要继续提交吗？' },
            '仍然提交'
        );
        if (pick !== '仍然提交') {
            return;
        }
    }

    const message = await vscode.window.showInputBox({
        title: '提交信息',
        prompt: `AI 审查结果：${outcome.message}`,
        value: '',
        ignoreFocusOut: true,
        validateInput: (value) => (value.trim() ? undefined : '提交信息不能为空'),
    });
    if (!message || !message.trim()) {
        log('未填写提交信息，已取消提交');
        return;
    }

    try {
        await runGit(['commit', '-m', message.trim()], repo, 120000);
        const head = await currentHead(repo);
        markHeadReviewed(repo, head); // 这次提交已经审过，避免事后监听再审一遍
        log(`已提交 ${head.slice(0, 8)}：${message.trim()}`);
        vscode.window.showInformationMessage(`已提交 ${head.slice(0, 8)}（审查：${outcome.message}）`);
    } catch (e) {
        const text = (e as Error).message;
        logError(`提交失败：${text}`);
        vscode.window.showErrorMessage(`提交失败：${text}`);
    }
}
