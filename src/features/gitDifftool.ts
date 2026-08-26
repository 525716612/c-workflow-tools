import * as vscode from 'vscode';
import { runGitAsync, runGitSync, getGitWorkingDir, pickTwoRefs } from '../utils/git';
import { log, logError, showChannel } from '../outputChannel';

/**
 * 检查是否已配置 difftool（diff.tool 或 diff.guitool）。
 * @returns 已配置返回 true；未配置返回 false
 */
async function hasDifftoolConfigured(cwd: string): Promise<boolean> {
    try {
        const tool = await runGitSync(['config', '--get', 'diff.tool'], cwd);
        if (tool) { return true; }
    } catch { /* 未配置 */ }
    try {
        const guiTool = await runGitSync(['config', '--get', 'diff.guitool'], cwd);
        if (guiTool) { return true; }
    } catch { /* 未配置 */ }
    return false;
}

/**
 * 功能2：Git 任意两个节点呼出 difftool 对比。
 * 让用户选择任意两个 git 节点（commit/分支/tag），
 * 调用用户 git config 中已配置的 difftool（如 Beyond Compare）进行目录对比。
 */
export async function gitDifftoolCompare(): Promise<void> {
    const cwd = getGitWorkingDir();
    if (!cwd) {
        const msg = '未找到 Git 仓库。请先打开一个位于 Git 仓库内的文件或工作区。';
        logError(msg);
        vscode.window.showWarningMessage(msg);
        return;
    }

    // 预检 difftool 配置（最常见"没反应"原因：未配置 diff.tool / diff.guitool）
    if (!(await hasDifftoolConfigured(cwd))) {
        const msg = '未检测到 difftool 配置。请先执行 git config --global diff.tool <工具名>（或 diff.guitool），例如：git config --global diff.tool bc';
        logError(msg);
        vscode.window.showErrorMessage(msg, '打开文档')
            .then((choice) => {
                if (choice === '打开文档') {
                    void vscode.env.openExternal(
                        vscode.Uri.parse('https://git-scm.com/docs/git-difftool')
                    );
                }
            });
        return;
    }

    // 选择两个节点（选完直接执行，不再二次确认）
    const refs = await pickTwoRefs(cwd);
    if (!refs) {
        return; // 用户取消
    }
    const [ref1, ref2] = refs;

    showChannel();
    log(`开始 difftool 对比：${ref1} vs ${ref2} (cwd=${cwd})`);

    try {
        // 目录级对比：git difftool <ref1> <ref2>
        const child = runGitAsync(['difftool', '--dir-diff', ref1, ref2], cwd);
        let stderr = '';
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

        // difftool 关闭前 git 会一直阻塞，用进度提示覆盖整个等待期
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `difftool 目录对比中：${ref1} vs ${ref2}（关闭对比窗口后自动结束）`,
            },
            () =>
                new Promise<void>((resolve) => {
                    let settled = false;
                    const finish = (): void => {
                        if (settled) { return; }
                        settled = true;
                        resolve();
                    };
                    child.on('error', (err) => {
                        logError(`difftool 启动失败：${err.message}`);
                        vscode.window.showErrorMessage(`difftool 启动失败：${err.message}`);
                        finish();
                    });
                    child.on('exit', (code) => {
                        if (code !== 0) {
                            const detail = stderr.trim() || '未知错误';
                            logError(`difftool 退出码 ${code}：${detail}`);
                            vscode.window.showErrorMessage(`difftool 对比失败（退出码 ${code}）：${detail}`);
                        } else {
                            log('difftool 已退出（code=0）');
                        }
                        finish();
                    });
                })
        );
    } catch (e) {
        const err = e as Error;
        logError(`difftool 调用出错：${err.message}`);
        vscode.window.showErrorMessage(`difftool 调用出错：${err.message}`);
    }
}
