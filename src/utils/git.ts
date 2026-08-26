import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { log, logError } from '../outputChannel';

/** git 差异文件状态 */
export type GitChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

/** 一个差异文件条目 */
export interface GitChange {
    status: GitChangeStatus;
    /** 变更后的相对路径（对于删除文件可能为空） */
    newPath: string;
    /** 变更前的相对路径（仅重命名/复制时有意义） */
    oldPath: string;
}

/**
 * 在指定目录或其上级目录中查找 .git 根目录。
 * 返回仓库根目录绝对路径；未找到返回 undefined。
 */
export function findGitRoot(cwd: string): string | undefined {
    let dir = cwd;
    while (dir) {
        if (fs.existsSync(path.join(dir, '.git'))) {
            return dir;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            break;
        }
        dir = parent;
    }
    return undefined;
}

/**
 * 判断一个目录是否位于 git 仓库内。
 */
export function isInsideGitRepo(cwd: string): boolean {
    return findGitRoot(cwd) !== undefined;
}

/**
 * 同步执行 git 命令并返回 stdout（去除末尾换行）。
 * @param args git 参数
 * @param cwd 工作目录
 * @param timeout 超时毫秒，默认 120s
 */
export function runGitSync(args: string[], cwd: string, timeout = 120000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn('git', args, {
            cwd,
            shell: process.platform === 'win32',
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`git 命令超时：git ${args.join(' ')}`));
        }, timeout);

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout.replace(/\s+$/, ''));
            } else {
                reject(new Error(stderr.trim() || `git 退出码 ${code}：git ${args.join(' ')}`));
            }
        });
    });
}

/**
 * 异步执行 git 命令（不等待完成，用于 difftool 这类阻塞式 GUI 工具）。
 * 返回子进程句柄。
 */
export function runGitAsync(args: string[], cwd: string): ReturnType<typeof spawn> {
    log(`[git] ${args.join(' ')}  (cwd=${cwd})`);
    return spawn('git', args, {
        cwd,
        shell: process.platform === 'win32',
        windowsHide: true,
    });
}

/** git 引用类型：分支 / 标签 / HEAD */
export type GitRefKind = 'branch' | 'tag' | 'HEAD';

/** 一个 git 引用条目 */
export interface GitRef {
    /** 引用显示名：分支名 / tag 名 / HEAD */
    label: string;
    /** 引用类型 */
    kind: GitRefKind;
}

/**
 * 获取当前仓库所有可选引用（分支、tag、HEAD）。
 * 注意：这些是可移动的「引用（分支/标签）」，并非不可变的 commit 节点；
 * 如需对比某个具体 commit 节点，应让用户粘贴 commit 哈希。
 */
export async function getRefs(cwd: string): Promise<GitRef[]> {
    const refs = new Map<string, GitRef>();
    try {
        const branches = await runGitSync(['branch', '--format=%(refname:short)'], cwd);
        branches.split(/\r?\n/).forEach((b) => {
            if (b) { refs.set(b, { label: b, kind: 'branch' }); }
        });
    } catch (e) {
        logError(`读取分支失败：${(e as Error).message}`);
    }
    try {
        const tags = await runGitSync(['tag'], cwd);
        tags.split(/\r?\n/).forEach((t) => {
            if (t && !refs.has(t)) { refs.set(t, { label: t, kind: 'tag' }); }
        });
    } catch (e) {
        logError(`读取标签失败：${(e as Error).message}`);
    }
    refs.set('HEAD', { label: 'HEAD', kind: 'HEAD' });
    return Array.from(refs.values());
}

/**
 * 获取两个节点之间的差异文件列表（name-status 解析）。
 * 支持重命名解析。
 */
export async function getDiffBetween(ref1: string, ref2: string, cwd: string): Promise<GitChange[]> {
    const raw = await runGitSync(['diff', '--name-status', '--find-renames', ref1, ref2], cwd);
    const changes: GitChange[] = [];
    raw.split(/\r?\n/).forEach((line) => {
        if (!line) { return; }
        const parts = line.split('\t');
        if (parts.length < 2) { return; }
        // --find-renames 时重命名输出形如 "R100\t旧路径\t新路径"，只取状态首字母
        const status = parts[0].charAt(0) as GitChangeStatus;
        const oldPath = parts[1];
        const newPath = parts[2] ?? parts[1];
        changes.push({ status, oldPath, newPath });
    });
    return changes;
}

/** Windows 命令行长度预算（CreateProcess 上限 32767，git 内部重派发更保守，留足余量） */
const ARGV_BUDGET = 7000;

/**
 * 从指定节点批量提取文件到磁盘（纯 git 原生命令实现）。
 * 流程：
 *   1) `git ls-tree` 过滤出该节点真实存在的文件（diff 里的新增/删除文件在另一节点
 *      不存在是必然的，必须预先过滤，否则 git archive 遇到不存在的 pathspec 会直接 fatal）；
 *   2) `git archive` 用位置参数传路径，按命令行长度预算分批导出 -> 系统 tar 解压。
 * git archive 不支持 --pathspec-from-file（git 2.55 实测），故用位置参数。
 * 每批只读所需文件，不读全树；全程 1 + 2N 个原生命令进程，二进制安全。
 * @param cwd git 仓库根目录
 * @param ref 节点引用（分支/tag/hash）
 * @param paths 需要提取的相对路径列表
 * @param targetRoot 写入的目标目录（需已存在）
 * @param onProgress 每批完成时回调（已完成批数, 总批数）
 */
export async function extractFilesFromRef(
    cwd: string,
    ref: string,
    paths: string[],
    targetRoot: string,
    onProgress?: (done: number, total: number) => void
): Promise<void> {
    if (paths.length === 0) { return; }

    // 1) 该节点全树路径集合（一次 git 进程；-z 以 NUL 分隔，路径含空格/中文也安全）
    const treeRaw = await runGitSync(['ls-tree', '-r', '-z', '--name-only', ref], cwd);
    const tree = new Set(treeRaw.split('\0').filter((p) => p !== ''));
    const existing = paths.filter((p) => tree.has(p));
    if (existing.length === 0) { return; }

    // 2) 按命令行长度预算分批；:(literal) 前缀禁用 glob 通配，路径含 * ? [ 等字符也精确匹配
    const chunks: string[][] = [];
    let cur: string[] = [];
    let curLen = 0;
    for (const p of existing) {
        const arg = `:(literal)${p}`;
        const add = arg.length + 1;
        if (cur.length > 0 && curLen + add > ARGV_BUDGET) {
            chunks.push(cur);
            cur = [];
            curLen = 0;
        }
        cur.push(arg);
        curLen += add;
    }
    if (cur.length > 0) { chunks.push(cur); }

    // 3) 分批 git archive（流中只含所需文件）-> 管道给系统 tar 解压
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const archive = spawn('git', ['archive', '--format=tar', ref, ...chunk], { cwd, windowsHide: true });
        const tar = spawn('tar', ['-xf', '-', '-C', targetRoot], { windowsHide: true });

        let stderr = '';
        archive.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        archive.stdout.pipe(tar.stdin);

        const [aCode, tCode] = await Promise.all([
            new Promise<number | null>((resolve, reject) => {
                archive.on('error', reject);
                archive.on('close', (code) => resolve(code));
            }),
            new Promise<number | null>((resolve, reject) => {
                tar.on('error', reject);
                tar.on('close', (code) => resolve(code));
            }),
        ]);

        if (aCode !== 0) {
            throw new Error(`git archive 退出码 ${aCode}：${stderr.trim() || '未知错误'}`);
        }
        if (tCode !== 0) {
            throw new Error(`tar 解压失败（退出码 ${tCode}）`);
        }
        onProgress?.(i + 1, chunks.length);
    }
}

/**
 * 获取 git 的当前活动工作目录（从打开的编辑器推断；未找到返回 undefined）。
 */
export function getGitWorkingDir(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.document.isUntitled) {
        const dir = path.dirname(editor.document.uri.fsPath);
        const root = findGitRoot(dir);
        if (root) {
            return root;
        }
    }
    // 回退到工作区根目录
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
        for (const f of folders) {
            const root = findGitRoot(f.uri.fsPath);
            if (root) {
                return root;
            }
        }
    }
    return undefined;
}

/**
 * 获取当前分支名（detached HEAD 时返回 HEAD）。
 */
export async function getCurrentBranch(cwd: string): Promise<string> {
    try {
        const branch = await runGitSync(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
        return branch === 'HEAD' ? 'HEAD' : branch;
    } catch {
        return 'HEAD';
    }
}

/** 引用类型在 QuickPick 列表中的说明文字 */
const REF_KIND_DESCRIPTION: Record<GitRefKind, string> = {
    branch: '$(git-branch) 分支',
    tag: '$(tag) 标签',
    HEAD: '$(git-commit) HEAD',
};

/**
 * 让用户通过 QuickPick 选择两个 git 引用（分支/tag，或粘贴 commit 哈希）。
 * 列表项是「分支/标签」这类引用，而非 commit 节点；
 * 如需对比某个具体 commit 节点，请将哈希值粘贴到输入框。
 * 当前分支置顶并默认选中；第二个引用默认 HEAD。
 * @param cwd git 仓库根目录
 * @returns [ref1, ref2] 或 undefined（取消）
 */
export async function pickTwoRefs(cwd: string): Promise<[string, string] | undefined> {
    const refs = await getRefs(cwd);
    const currentBranch = await getCurrentBranch(cwd);
    // 当前分支置顶
    const orderedRefs = [
        ...refs.filter((r) => r.label === currentBranch),
        ...refs.filter((r) => r.label !== currentBranch),
    ];

    const pickOne = (title: string, placeHolder: string, defaultRef: string): Promise<string | undefined> => {
        return new Promise((resolve) => {
            const quickPick = vscode.window.createQuickPick();
            quickPick.title = title;
            quickPick.placeholder = placeHolder;
            quickPick.matchOnDescription = true;
            quickPick.ignoreFocusOut = true;
            quickPick.items = orderedRefs.map((r) => ({
                label: r.label,
                description: REF_KIND_DESCRIPTION[r.kind],
            }));
            // 默认高亮选中指定引用
            quickPick.activeItems = quickPick.items.filter((i) => i.label === defaultRef);
            quickPick.show();

            // 防止 dispose() 触发 onDidHide 导致 resolve 被重复调用（第二次会抢先以 undefined 结束）
            let finished = false;
            const finish = (result: string | undefined): void => {
                if (finished) { return; }
                finished = true;
                quickPick.dispose();
                resolve(result);
            };

            quickPick.onDidAccept(() => {
                // 输入了新内容（如 commit hash）优先用输入值；否则用列表选中项
                const value = quickPick.value.trim();
                const selected = quickPick.selectedItems[0]?.label;
                finish(value || selected || undefined);
            });
            quickPick.onDidHide(() => {
                finish(undefined);
            });
        });
    };

    const ref1 = await pickOne(
        'C Workflow：选择对比分支 (1/2)',
        '当前选择的是分支（回车确认）；如需对比某个 commit 节点，请将哈希值粘贴到输入框',
        currentBranch
    );
    if (!ref1) { return undefined; }
    const ref2 = await pickOne(
        `C Workflow：选择对比分支 (2/2)（已选 ${ref1}）`,
        '当前选择的是分支（回车确认）；如需对比某个 commit 节点，请将哈希值粘贴到输入框',
        'HEAD'
    );
    if (!ref2) { return undefined; }
    log(`已选择对比引用：${ref1} vs ${ref2}`);
    return [ref1, ref2];
}
