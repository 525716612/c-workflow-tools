import { spawn } from 'child_process';
import * as path from 'path';
import { killProcessTree } from '../utils/proc';

/**
 * 引擎专用的 git 调用层。
 *
 * 关键约束：本文件（以及 src/aiReview/ 下所有文件）**不能 import vscode**。
 * 引擎要能作为独立 Node 进程运行（命令行入口、以及脱离 IDE 的自测），
 * 一旦引入 vscode 模块，独立运行时会因 require('vscode') 失败而崩。
 */

/** git 选项：禁用分页/颜色，路径不做引号转义（便于解析），路径按字面量处理 */
const GIT_OPTS = [
    // --literal-pathspecs：文件名里的 * ? [ 或 : 前缀不会被当 glob/pathspec 魔法
    '--literal-pathspecs',
    '-c', 'core.quotepath=false',
    '-c', 'core.pager=cat',
    '-c', 'color.ui=false',
];

/**
 * 执行 git 并返回 stdout（去掉尾部空白）。
 * 非 0 退出码会 reject（带上 stderr 便于定位）。
 */
export function runGit(args: string[], cwd: string, timeoutMs = 120000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const child = spawn('git', [...GIT_OPTS, ...args], {
            cwd,
            // Windows 下 git 是 exe，不需要 shell；用 shell 反而会多一层 cmd.exe
            shell: false,
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const settle = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            action();
        };
        const timer = setTimeout(() => {
            killProcessTree(child);
            settle(() => reject(new Error(`git 超时（${timeoutMs}ms）：git ${args.join(' ')}`)));
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => {
            if (stderr.length < 64 * 1024) { stderr += d.toString('utf8'); }
        });
        child.on('error', (err) => settle(() => reject(err)));
        child.on('close', (code) => {
            settle(() => {
                if (code === 0) {
                    resolve(stdout.replace(/\s+$/, ''));
                } else {
                    reject(new Error(stderr.trim() || `git 退出码 ${code}：git ${args.join(' ')}`));
                }
            });
        });
    });
}

/** 执行 git，失败时返回空串（用于"探测性"调用，例如判断对象是否存在） */
export async function runGitQuiet(args: string[], cwd: string, timeoutMs = 120000): Promise<string> {
    try {
        return await runGit(args, cwd, timeoutMs);
    } catch {
        return '';
    }
}

/** 判断 git 命令是否成功（只看退出码） */
export async function gitSucceeds(args: string[], cwd: string, timeoutMs = 30000): Promise<boolean> {
    try {
        await runGit(args, cwd, timeoutMs);
        return true;
    } catch {
        return false;
    }
}

/** 仓库根目录 */
export async function gitRoot(cwd: string): Promise<string> {
    return runGit(['rev-parse', '--show-toplevel'], cwd, 30000);
}

/** git 目录（--git-common-dir，兼容 worktree/子模块） */
export async function gitCommonDir(root: string): Promise<string> {
    const raw = await runGit(['rev-parse', '--git-common-dir'], root, 30000);
    return path.isAbsolute(raw) ? raw : path.join(root, raw);
}

/** 当前 HEAD（没有提交时返回空串） */
export async function gitHead(root: string): Promise<string> {
    return runGitQuiet(['rev-parse', 'HEAD'], root, 30000);
}

/** 最近一次 HEAD 动作描述，如 "commit: msg" / "merge feature" / "rebase (finish)" / "checkout: ..." */
export async function gitLastAction(root: string): Promise<string> {
    return runGitQuiet(['reflog', 'show', 'HEAD', '-1', '--format=%gs'], root, 30000);
}

/** 提交的父提交列表 */
export async function gitParents(root: string, rev: string): Promise<string[]> {
    const raw = await runGitQuiet(['rev-list', '--parents', '-n', '1', rev], root, 30000);
    const parts = raw.split(/\s+/).filter(Boolean);
    return parts.slice(1);
}

/** a 是否为 b 的祖先（a == b 时为 true） */
export async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
    return gitSucceeds(['merge-base', '--is-ancestor', a, b], root);
}

/** 提交的短标签（用于报告里标注来源提交） */
export async function commitLabel(root: string, rev: string): Promise<string> {
    const raw = await runGitQuiet(['log', '-1', '--format=%h %s', rev], root, 30000);
    return raw.split(/\r?\n/)[0] || rev.slice(0, 8);
}

/** 提交信息（subject） */
export async function subjectOf(root: string, rev: string): Promise<string> {
    const raw = await runGitQuiet(['log', '-1', '--format=%s', rev], root, 30000);
    return raw.split(/\r?\n/)[0] ?? '';
}

/** 批量取「subject → sha」映射（变基时按提交信息把新旧提交配对） */
export async function subjectMap(root: string, revs: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (revs.length === 0) {
        return map;
    }
    const raw = await runGitQuiet(['log', '--no-walk', '--format=%H%x09%s', ...revs], root, 60000);
    for (const line of raw.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab <= 0) {
            continue;
        }
        const sha = line.slice(0, tab).trim();
        const subject = line.slice(tab + 1).trim();
        if (sha && subject) {
            map.set(subject, sha);
        }
    }
    return map;
}

/**
 * 从 reflog 读出「本次变基实际重放的提交」。
 *
 * 这是变基事后判定唯一可靠的依据：变基后 sha 全部变了，光靠 diff 无法区分
 * "被重放的自己的提交"和"新基线带进来的提交"（后者不该在这里审）。
 * reflog 会按顺序记录 `rebase (pick): <subject>`（`git pull --rebase` 同理），
 * 往回读到 `(start)` 就停，那里之前是变基前的旧提交。
 */
export async function rebaseReplayed(root: string): Promise<string[]> {
    const raw = await runGitQuiet(
        ['reflog', 'show', 'HEAD', '-n', '80', '--format=%H%x09%gs'], root, 30000);
    const picks: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab <= 0) {
            continue;
        }
        const sha = line.slice(0, tab).trim();
        const subject = line.slice(tab + 1).trim();
        if (subject.includes('(start)')) {
            break;
        }
        if (subject.includes('(pick)')) {
            picks.push(sha);
        }
    }
    return picks.reverse(); // reflog 新的在前，反转成实际应用顺序
}
