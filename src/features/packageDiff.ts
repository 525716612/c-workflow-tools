import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import archiver from 'archiver';
import { getGitWorkingDir, pickTwoRefs, getDiffBetween, extractFilesFromRef, GitChange } from '../utils/git';
import { log, logError, showChannel } from '../outputChannel';

/** 打包结果的临时目录前缀 */
const TMP_PREFIX = 'c-workflow-diff-';

/**
 * 功能3：打包 Git 两个节点之间的差异文件。
 * 将两节点间的差异文件按「修改前」和「修改后」两个子目录整理，
 * 打包为 zip，便于发送给他人导入对策。
 */
export async function packageDiff(): Promise<void> {
    const cwd = getGitWorkingDir();
    if (!cwd) {
        const msg = '未找到 Git 仓库。请先打开一个位于 Git 仓库内的文件或工作区。';
        logError(msg);
        vscode.window.showWarningMessage(msg);
        return;
    }

    const refs = await pickTwoRefs(cwd);
    if (!refs) {
        return; // 用户取消
    }
    const [ref1, ref2] = refs;

    showChannel();
    log(`开始打包差异文件：${ref1} vs ${ref2} (cwd=${cwd})`);

    let changes: GitChange[];
    try {
        changes = await getDiffBetween(ref1, ref2, cwd);
    } catch (e) {
        const err = e as Error;
        logError(`获取差异列表失败：${err.message}`);
        vscode.window.showErrorMessage(`获取差异列表失败：${err.message}`);
        return;
    }

    if (changes.length === 0) {
        const msg = `两节点 ${ref1} 与 ${ref2} 之间没有差异文件。`;
        log(msg);
        vscode.window.showInformationMessage(msg);
        return;
    }

    log(`共发现 ${changes.length} 个差异文件。`);

    // 确认输出位置
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(cwd, `diff_${sanitize(ref1)}_${sanitize(ref2)}.zip`)),
        filters: { 'ZIP 压缩包': ['zip'] },
        saveLabel: '保存差异包',
    });
    if (!saveUri) {
        return;
    }
    const zipPath = saveUri.fsPath;

    // 在系统临时目录构建「修改前/修改后」结构
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
    const beforeDir = path.join(tmpRoot, '修改前');
    const afterDir = path.join(tmpRoot, '修改后');

    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: `打包差异文件：${ref1} vs ${ref2}`,
            },
            async (progress) => {
                // 提取占 80%，压缩占 20%
                let lastPct = 0;
                const reportPct = (pct: number, message: string): void => {
                    progress.report({ increment: Math.max(0, pct - lastPct), message });
                    lastPct = pct;
                };

                reportPct(0, '提取差异文件…');
                await buildDiffTree(changes, ref1, ref2, cwd, beforeDir, afterDir, (done, total) => {
                    reportPct(
                        total > 0 ? Math.round((80 * done) / total) : 0,
                        `提取差异文件：${done}/${total} 批`
                    );
                });

                reportPct(80, '压缩中…');
                await createZip(tmpRoot, zipPath);
                reportPct(100, '完成');
            }
        );
        log(`差异包已生成：${zipPath}`);
        vscode.window.showInformationMessage(`差异包已生成：${zipPath}`);
    } catch (e) {
        const err = e as Error;
        logError(`打包失败：${err.message}`);
        vscode.window.showErrorMessage(`打包失败：${err.message}`);
    } finally {
        // 清理临时目录
        try {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        } catch {
            // 忽略清理错误
        }
    }
}

/**
 * 将差异文件分别提取到「修改前」「修改后」目录。
 * 新增文件（A）只存在于修改后；删除文件（D）只存在于修改前；
 * 修改/重命名等两节点均保留。
 * @param onProgress 提取批次进度回调（已完成批数, 总批数，两侧累计）
 */
async function buildDiffTree(
    changes: GitChange[],
    ref1: string,
    ref2: string,
    cwd: string,
    beforeDir: string,
    afterDir: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });

    // 修改后：ref2 中所有非删除文件（新增/修改/重命名取新路径）
    const afterPaths = changes
        .filter((c) => c.status !== 'D')
        .map((c) => c.newPath)
        .filter((p) => p);
    // 修改前：ref1 中所有非新增文件（删除/修改取原路径；重命名取旧路径）
    const beforePaths = changes
        .filter((c) => c.status !== 'A')
        .map((c) => (c.status === 'R' ? c.oldPath : c.newPath))
        .filter((p) => p);

    // 两侧批次进度累计上报（先报 after 再报 before，总量单调增长）
    let done = 0;
    let total = 0;
    const report = (d: number, t: number): void => {
        done += d;
        total += t;
        onProgress?.(done, total);
    };

    await extractFilesFromRef(cwd, ref2, afterPaths, afterDir, report);
    await extractFilesFromRef(cwd, ref1, beforePaths, beforeDir, report);
}

/**
 * 将临时目录打包为 zip。
 */
async function createZip(srcDir: string, zipPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', () => resolve());
        output.on('error', reject);
        archive.on('error', reject);

        archive.pipe(output);
        archive.directory(srcDir, path.basename(zipPath).replace(/\.zip$/i, ''));
        archive.finalize();
    });
}

/**
 * 清理节点引用中的非法字符，用于生成默认文件名。
 */
function sanitize(ref: string): string {
    return ref.replace(/[\\/:*?"<>|\s]/g, '_');
}
