import {
    runGit, runGitQuiet, gitParents, commitLabel, subjectMap, subjectOf, rebaseReplayed,
} from './gitRun';
import type { CollectResult, DiffEntry, ReviewConfig } from './types';

/**
 * 待审查内容的收集（各范围统一走 collectDiff）。
 *
 * 范围：
 *   staged  暂存区（普通本地提交）
 *   commit  单个提交自身的改动（普通提交/修订单个提交）
 *   merge   合并提交里"人工解冲突"的文件（与两个父提交都不同）
 *   rebase  变基过程中被人工改写的提交（逐提交比对增删行签名）
 *   sync    合并/拉取带入本分支的提交
 */

/** 值得审查的文件类型 */
const REVIEW_EXTS = new Set([
    '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cxx', '.inc', '.inl',
    '.s', '.asm', '.a51', '.ld', '.sct',
    '.py', '.js', '.ts', '.tsx', '.vue', '.java', '.cs', '.go', '.rs',
    '.sh', '.bat', '.cmd', '.ps1', '.pl', '.rb',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
    '.mk', '.cmake', '.md', '.html', '.css',
]);
const REVIEW_FILENAMES = new Set(['makefile', 'gnumakefile', 'cmakelists.txt', 'kconfig']);
const SKIP_DIR_PARTS = new Set([
    '.git', '.codebuddy', 'node_modules', 'third_party', 'thirdparty', 'vendor',
    'external', 'dist', 'obj', 'out', 'bin', 'build', 'release', 'autobuildrelease',
]);
const SKIP_SUFFIXES = ['.min.js', '.min.css', '.g.cs', '.designer.cs', '.pb.cc', '.pb.h'];

/** 空树对象：用于给根提交（无父）生成 diff */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** 文件是否值得审查（类型白名单 + 目录/后缀黑名单） */
export function isReviewable(name: string): boolean {
    const norm = name.replace(/\\/g, '/');
    const lower = norm.toLowerCase();
    const parts = lower.split('/');
    const base = parts[parts.length - 1] ?? '';
    if (parts.some((part) => SKIP_DIR_PARTS.has(part))) {
        return false;
    }
    if (SKIP_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
        return false;
    }
    if (REVIEW_FILENAMES.has(base)) {
        return true;
    }
    const dot = base.lastIndexOf('.');
    return dot > 0 && REVIEW_EXTS.has(base.slice(dot));
}

function sumInt(values: string[]): number {
    let total = 0;
    for (const value of values) {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n)) {
            total += n;
        }
    }
    return total;
}

/**
 * 收集一个 diff 范围内值得审查的文件。
 *
 * @param repo    仓库根目录
 * @param diffArgs 传给 git diff 的范围参数（如 ['--cached'] 或 ['<old>', '<new>']）
 * @param pathspec 限定文件子集（可选，如合并场景只审冲突文件）
 * @param cfg     上限配置（文件数 / 体积 / 单文件行数）
 */
export async function collectDiff(
    repo: string,
    diffArgs: string[],
    pathspec: string[] | undefined,
    cfg: ReviewConfig
): Promise<CollectResult> {
    const tail = pathspec && pathspec.length > 0 ? ['--', ...pathspec] : [];
    const namesRaw = await runGit(
        ['diff', ...diffArgs, '--no-renames', '--diff-filter=ACMR', '--name-only', '-z', ...tail],
        repo
    );
    const names = namesRaw.split('\0').filter((n) => n !== '');

    const stats = new Map<string, [string, string]>();
    const numstat = await runGitQuiet(['diff', ...diffArgs, '--no-renames', '--numstat', ...tail], repo);
    for (const line of numstat.split(/\r?\n/)) {
        const parts = line.split('\t');
        if (parts.length >= 3) {
            stats.set(parts.slice(2).join('\t'), [parts[0], parts[1]]);
        }
    }

    const reviewable: string[] = [];
    const skipped: string[] = [];
    for (const name of names) {
        (isReviewable(name) ? reviewable : skipped).push(name);
    }

    // 改动大的优先：剩余预算花在最相关的文件上
    const changedLines = (name: string): number => {
        const [added, deleted] = stats.get(name) ?? ['0', '0'];
        return sumInt([added, deleted]);
    };
    reviewable.sort((a, b) => changedLines(b) - changedLines(a));

    let budget = cfg.maxDiffKb * 1024;
    const entries: DiffEntry[] = [];
    const notes: string[] = [];
    let totalAdded = 0;
    let totalDeleted = 0;

    for (const name of reviewable) {
        if (entries.length >= cfg.maxFiles) {
            notes.push(`超出单次审查文件上限（${cfg.maxFiles}），跳过 ${reviewable.length - entries.length} 个文件`);
            break;
        }
        const [added, deleted] = stats.get(name) ?? ['0', '0'];
        totalAdded += sumInt([added]);
        totalDeleted += sumInt([deleted]);
        if (added === '-' || deleted === '-') {
            skipped.push(name); // 二进制
            continue;
        }

        let patch = await runGitQuiet(
            ['diff', ...diffArgs, '--no-renames', '--unified=5', '--', name],
            repo
        );
        if (patch.trim() === '' || patch.includes('GIT binary patch')) {
            skipped.push(name);
            continue;
        }

        let truncated = false;
        const lines = patch.split(/\r?\n/);
        if (lines.length > cfg.maxFileLines) {
            patch = lines.slice(0, cfg.maxFileLines).join('\n');
            truncated = true;
        }

        const size = Buffer.byteLength(patch, 'utf8');
        if (size > budget) {
            notes.push(`diff 体积超出上限（${cfg.maxDiffKb}KB），跳过 ${name}`);
            continue;
        }
        budget -= size;

        if (truncated) {
            patch += `\n[... 该文件 diff 过长已截断，仅显示前 ${cfg.maxFileLines} 行 ...]`;
        }
        entries.push({
            path: name,
            added: sumInt([added]),
            deleted: sumInt([deleted]),
            patch,
            truncated,
        });
    }

    return { entries, skipped, notes, added: totalAdded, deleted: totalDeleted };
}

/** 暂存区改动（普通提交） */
export function collectStaged(repo: string, cfg: ReviewConfig): Promise<CollectResult> {
    return collectDiff(repo, ['--cached'], undefined, cfg);
}

/**
 * 单个提交自身的改动（对比它的第一个父提交；根提交对比空树）。
 *
 * 注意不能用 `git diff <旧sha> <新sha>`：变基后父提交变了，会把新基线的改动也带进来。
 */
export async function commitDiffArgs(repo: string, rev: string): Promise<string[]> {
    const parents = await gitParents(repo, rev);
    return parents.length > 0 ? [parents[0], rev] : [EMPTY_TREE, rev];
}

/** patch 的增删行签名：两次提交引入相同代码时签名相同（用于判断变基是否改写过内容） */
export function patchSignature(text: string): string {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('+++') || line.startsWith('---')) {
            continue;
        }
        if (line.startsWith('+') || line.startsWith('-')) {
            lines.push(line);
        }
    }
    return lines.join('\n');
}

/** 单个提交自身的 patch（用于变基比对） */
export async function commitPatch(repo: string, rev: string): Promise<string> {
    return runGitQuiet(['diff', '--no-renames', '--unified=3', ...(await commitDiffArgs(repo, rev))], repo);
}

/** 审查单个提交（自带来源标注） */
export async function collectCommit(repo: string, rev: string, cfg: ReviewConfig): Promise<CollectResult> {
    const result = await collectDiff(repo, await commitDiffArgs(repo, rev), undefined, cfg);
    const label = await commitLabel(repo, rev);
    for (const entry of result.entries) {
        entry.commit = label;
    }
    return result;
}

/**
 * 合并提交：只挑"人工解冲突"的文件。
 *
 * 判据是「与两个父提交都不同」——干净合并时文件内容必然等于某一侧，
 * 只有人手动改过才会两边都不一样。无冲突的合并因此不会有任何条目（0 次 AI 调用）。
 */
export async function collectMerge(repo: string, rev: string, cfg: ReviewConfig): Promise<CollectResult> {
    const parents = await gitParents(repo, rev);
    if (parents.length < 2) {
        return { entries: [], skipped: [], notes: [], added: 0, deleted: 0 };
    }
    const changedVs = async (parent: string): Promise<Set<string>> => {
        const raw = await runGitQuiet(['diff', '--no-renames', '--name-only', parent, rev], repo);
        return new Set(raw.split(/\r?\n/).filter((n) => n !== ''));
    };
    const vsFirst = await changedVs(parents[0]);
    const vsOthers = await Promise.all(parents.slice(1).map((p) => changedVs(p)));

    const resolved: string[] = [];
    for (const name of vsFirst) {
        if (!isReviewable(name)) {
            continue;
        }
        // 与每个父提交都不同 ⇒ 这段内容是人写的
        if (vsOthers.every((set) => set.has(name))) {
            resolved.push(name);
        }
    }
    if (resolved.length === 0) {
        return { entries: [], skipped: [], notes: [], added: 0, deleted: 0 };
    }

    const result = await collectDiff(repo, [parents[0], rev], resolved, cfg);
    const label = await commitLabel(repo, rev);
    for (const entry of result.entries) {
        entry.commit = `合并解冲突 ${label}`;
    }
    result.notes.push(`合并提交只审查人工解冲突的 ${resolved.length} 个文件（其余内容来自被合并分支）`);
    return result;
}

/**
 * 变基（事后判定）：找出内容被人工改写的提交。
 *
 * 两步判定：
 *   1. 候选提交以 reflog 里的 `rebase (pick)` 为准 —— 只有这些才是本次变基重放的
 *      自己的提交；新基线带进来的提交不在其中（它们不是"被改写"的内容，这里不该审）。
 *      reflog 不可用时退化为「新出现的提交里、提交信息在旧提交中存在同名者」。
 *   2. 候选与原始提交按「增删行签名」比对：一致 = 原样重放（原提交时已审过）→ 跳过；
 *      不一致或找不到原提交 = 解冲突时人工改写过 → 审查。
 */
export async function collectRebase(
    repo: string,
    oldHead: string,
    newHead: string,
    cfg: ReviewConfig
): Promise<CollectResult> {
    const newCommits = (await runGitQuiet(['rev-list', newHead, '--not', oldHead], repo))
        .split(/\r?\n/).filter(Boolean);
    if (newCommits.length === 0) {
        return { entries: [], skipped: [], notes: [], added: 0, deleted: 0 };
    }
    const oldCommits = (await runGitQuiet(['rev-list', oldHead, '--not', newHead], repo))
        .split(/\r?\n/).filter(Boolean);

    const picks = await rebaseReplayed(repo);
    const oldBySubject = await subjectMap(repo, oldCommits);
    const candidates = picks.length > 0 ? picks : newCommits;

    const entries: DiffEntry[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    let added = 0;
    let deleted = 0;
    let rewritten = 0;

    for (const rev of candidates.slice(0, cfg.maxCommits)) {
        const subject = await subjectOf(repo, rev);
        const original = oldBySubject.get(subject);
        if (!original && picks.length === 0) {
            continue; // 没有 reflog 依据时，只处理能与旧提交配对的，避免把新基线提交当改写
        }
        if (original
            && patchSignature(await commitPatch(repo, original)) === patchSignature(await commitPatch(repo, rev))) {
            continue; // 原样重放，原提交时已审过
        }
        rewritten += 1;
        const sub = await collectCommit(repo, rev, cfg);
        if (sub.entries.length === 0) {
            continue;
        }
        entries.push(...sub.entries);
        skipped.push(...sub.skipped);
        notes.push(...sub.notes);
        added += sub.added;
        deleted += sub.deleted;
    }
    if (candidates.length > cfg.maxCommits) {
        notes.push(`变基重放的提交较多，只检查了最近的 ${cfg.maxCommits} 个`);
    }
    if (entries.length > 0) {
        notes.push(`变基中有 ${rewritten} 个提交内容被改写，只审查这些提交`
            + (picks.length > 0 ? '' : '（reflog 不可用，按提交信息配对近似判定）'));
    }
    return { entries, skipped, notes, added, deleted };
}

/**
 * 同步（事后判定）：合并/拉取带入本分支的提交。
 * 传入的是「本分支原先没有的提交」，因此只需审它们的 patch。
 */
export async function collectSync(
    repo: string,
    oldHead: string,
    newHead: string,
    cfg: ReviewConfig
): Promise<CollectResult> {
    const raw = await runGitQuiet(['rev-list', newHead, '--not', oldHead], repo);
    const commits = raw.split(/\r?\n/).filter(Boolean);
    if (commits.length === 0) {
        return { entries: [], skipped: [], notes: [], added: 0, deleted: 0 };
    }

    const entries: DiffEntry[] = [];
    const skipped: string[] = [];
    const notes: string[] = [];
    let added = 0;
    let deleted = 0;
    // 新的在前：预算用在最新带入的代码上
    for (const rev of commits.slice(0, cfg.maxCommits)) {
        const sub = await collectCommit(repo, rev, cfg);
        entries.push(...sub.entries);
        skipped.push(...sub.skipped);
        notes.push(...sub.notes);
        added += sub.added;
        deleted += sub.deleted;
    }
    if (commits.length > cfg.maxCommits) {
        notes.push(`带入本分支的提交共 ${commits.length} 个，只审查最新的 ${cfg.maxCommits} 个`);
    }
    if (entries.length > 0) {
        notes.push(`本次带入本分支的提交共 ${Math.min(commits.length, cfg.maxCommits)} 个`);
    }
    return { entries, skipped, notes, added, deleted };
}
