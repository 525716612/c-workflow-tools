import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { getGitWorkingDir, pickTwoRefs, getDiffBetween, extractFilesFromRef, runGitSync, GitChange } from '../utils/git';
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

    // 「修改前/修改后」两个目录的内容完全由节点先后方向决定，选反会导致两边内容互换，
    // 因此选完两个节点后必须再确认一次方向（可直接交换）。
    const direction = await confirmDirection(refs[0], refs[1], cwd);
    if (!direction) {
        return; // 用户取消
    }
    const [refBefore, refAfter] = direction;

    showChannel();
    log(`开始打包差异文件：修改前=${refBefore}，修改后=${refAfter} (cwd=${cwd})`);

    let changes: GitChange[];
    try {
        changes = await getDiffBetween(refBefore, refAfter, cwd);
    } catch (e) {
        const err = e as Error;
        logError(`获取差异列表失败：${err.message}`);
        vscode.window.showErrorMessage(`获取差异列表失败：${err.message}`);
        return;
    }

    if (changes.length === 0) {
        const msg = `两节点 ${refBefore} 与 ${refAfter} 之间没有差异文件。`;
        log(msg);
        vscode.window.showInformationMessage(msg);
        return;
    }

    log(`共发现 ${changes.length} 个差异文件。`);

    // 确认输出位置
    const saveUri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(cwd, `diff_${sanitize(refBefore)}_${sanitize(refAfter)}.zip`)),
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
                title: `打包差异文件：${refBefore} → ${refAfter}`,
            },
            async (progress) => {
                // 提取占 80%，压缩占 20%
                let lastPct = 0;
                const reportPct = (pct: number, message: string): void => {
                    progress.report({ increment: Math.max(0, pct - lastPct), message });
                    lastPct = pct;
                };

                reportPct(0, '提取差异文件…');
                await buildDiffTree(changes, refBefore, refAfter, cwd, beforeDir, afterDir, (done, total) => {
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
 * @param refBefore 「修改前」对应的节点
 * @param refAfter 「修改后」对应的节点
 * @param onProgress 提取批次进度回调（已完成批数, 总批数，两侧累计）
 */
async function buildDiffTree(
    changes: GitChange[],
    refBefore: string,
    refAfter: string,
    cwd: string,
    beforeDir: string,
    afterDir: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    fs.mkdirSync(beforeDir, { recursive: true });
    fs.mkdirSync(afterDir, { recursive: true });

    // 修改后：refAfter 中所有非删除文件（新增/修改/重命名取新路径）
    const afterPaths = changes
        .filter((c) => c.status !== 'D')
        .map((c) => c.newPath)
        .filter((p) => p);
    // 修改前：refBefore 中所有非新增文件（删除/修改取原路径；重命名取旧路径）
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

    await extractFilesFromRef(cwd, refAfter, afterPaths, afterDir, report);
    await extractFilesFromRef(cwd, refBefore, beforePaths, beforeDir, report);
}

/**
 * 将临时目录打包为 zip。
 */
async function createZip(srcDir: string, zipPath: string): Promise<void> {
    // 懒加载 archiver：其依赖链（zip-stream/compress-commons/async/glob 等）体积较大，
    // 仅在用户真正执行「打包差异文件」时才加载，避免拖慢插件启动。
    // esbuild 已将其 bundle 进 dist，无需随 vsix 携带 node_modules。
    const archiver = require('archiver') as typeof import('archiver');
    return new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        let settled = false;

        // 出错时必须主动收尾：否则指向 zipPath 的写流与 archiver 内部句柄会一直挂着（资源泄漏）
        const finish = (err?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            if (err) {
                try { archive.abort(); } catch { /* 忽略 */ }
                try { output.destroy(); } catch { /* 忽略 */ }
                reject(err);
                return;
            }
            resolve();
        };

        output.on('close', () => finish());
        output.on('error', (e: Error) => finish(e));
        archive.on('error', (e: Error) => finish(e));
        archive.on('warning', (e: Error) => log(`打包告警：${e.message}`));

        archive.pipe(output);
        archive.directory(srcDir, path.basename(zipPath).replace(/\.zip$/i, ''));
        archive.finalize().catch((e: Error) => finish(e));
    });
}

/**
 * 清理节点引用中的非法字符，用于生成默认文件名。
 */
function sanitize(ref: string): string {
    return ref.replace(/[\\/:*?"<>|\s]/g, '_');
}

/** 节点提交摘要，用于确认「修改前/修改后」方向 */
interface RefSummary {
    ref: string;
    sha: string;
    date: string;
    subject: string;
}

/**
 * 读取节点的提交摘要（短哈希 / 提交日期 / 标题）。
 * 用户可能粘贴任意 commit 哈希，统一用 git log 解析；失败时返回占位信息。
 */
async function describeRef(ref: string, cwd: string): Promise<RefSummary> {
    try {
        const out = await runGitSync(['log', '-1', '--format=%h|%ad|%s', '--date=short', ref], cwd);
        const [sha, date, ...rest] = out.split('|');
        return {
            ref,
            sha: (sha ?? '').trim(),
            date: (date ?? '').trim(),
            subject: rest.join('|').trim(),
        };
    } catch (e) {
        logError(`读取节点信息失败（${ref}）：${(e as Error).message}`);
        return { ref, sha: '', date: '', subject: '（无法读取提交信息）' };
    }
}

/** 节点的单行描述：ref（短哈希 日期 标题） */
function formatRef(summary: RefSummary): string {
    const meta = [summary.sha, summary.date].filter(Boolean).join(' ');
    return meta
        ? `${summary.ref}（${meta} ${summary.subject}）`
        : `${summary.ref}（${summary.subject}）`;
}

/**
 * 确认「修改前 → 修改后」的方向。
 * 打包出的「修改前/修改后」目录内容完全由该方向决定，选反会让两边内容互换，
 * 因此在选完两个节点后再确认一次；若第二个节点的提交日期更早，说明当前顺序可能
 * 反了，此时把「交换」放在首位作为推荐项，回车即可纠正。
 * @returns [修改前节点, 修改后节点]；用户取消返回 undefined
 */
async function confirmDirection(
    ref1: string,
    ref2: string,
    cwd: string
): Promise<[string, string] | undefined> {
    const [first, second] = await Promise.all([describeRef(ref1, cwd), describeRef(ref2, cwd)]);
    // 日期为 YYYY-MM-DD 格式，可直接按字符串比较
    const looksReversed = Boolean(first.date && second.date && first.date > second.date);

    const keepItem: vscode.QuickPickItem = {
        label: `$(arrow-right) 修改前 = ${ref1}    →    修改后 = ${ref2}`,
        description: '保持刚才的选择顺序',
        detail: `修改前：${formatRef(first)}\n修改后：${formatRef(second)}`,
    };
    const swapItem: vscode.QuickPickItem = {
        label: `$(arrow-right) 修改前 = ${ref2}    →    修改后 = ${ref1}`,
        description: looksReversed ? '推荐：第二个节点的提交日期更早' : '交换两个节点的位置',
        detail: `修改前：${formatRef(second)}\n修改后：${formatRef(first)}`,
    };

    if (looksReversed) {
        log(`注意：${ref2}（${second.date}）早于 ${ref1}（${first.date}），当前顺序可能填反`);
    }

    const items = looksReversed ? [swapItem, keepItem] : [keepItem, swapItem];
    const picked = await vscode.window.showQuickPick(items, {
        title: 'C Workflow：确认「修改前 → 修改后」方向',
        placeHolder: '两个目录的内容由此方向决定，确认后再打包',
        ignoreFocusOut: true,
    });
    if (!picked) {
        return undefined;
    }
    const ordered: [string, string] = picked === keepItem ? [ref1, ref2] : [ref2, ref1];
    log(`方向已确认：修改前=${ordered[0]}，修改后=${ordered[1]}`);
    return ordered;
}
