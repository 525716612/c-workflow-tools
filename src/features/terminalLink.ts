import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { log, logError } from '../outputChannel';

/**
 * 终端路径链接功能。
 *
 * 自定义 Ctrl+点击 终端中路径的行为：
 * VS Code 默认会把整行文本全量复制到文件搜索栏，往往找不到文件；
 * 本模块负责从终端输出中裁剪出真正的文件路径（含可选行号/列号），
 * 点击后直接打开对应文件并跳转到指定行列。
 *
 * 支持的路径形态：
 * - 绝对路径：C:\proj\src\main.c、C:/proj/src/main.c、/home/u/proj/src/main.c、~/proj/src/main.c
 * - 相对路径：src\main.c、./src/main.c、../common/util.h（相对终端 cwd / 工作区根目录解析）
 * - 带空格路径（引号包裹）："D:\my dir\foo bar.c"
 * - 行号/行列后缀：path:12、path:12:5、path(12,45)（gcc/clang/MSVC 错误格式）
 * - CMake/ninja 构建产物：CMakeFiles/proj.dir/src/main.c.o（自动裁剪为源文件）
 */

/** 调试日志开关：置 true 后输出路径裁剪/定位日志到输出面板 */
const DEBUG = false;

/** 调试日志：DEBUG 开启时输出到输出面板；生产构建（minify）中会被常量折叠消除 */
function debugLog(message: string): void {
    if (DEBUG) {
        log(message);
    }
}

/**
 * 携带裁剪结果与终端 cwd 的链接。
 * 继承 vscode.TerminalLink，通过子类在 handleTerminalLink 中取回附加数据。
 */
class PathTerminalLink extends vscode.TerminalLink {
    constructor(
        startIndex: number,
        length: number,
        tooltip: string | undefined,
        /** 裁剪后的文件路径（不含引号、行号后缀） */
        readonly filePath: string,
        /** 行号（1 起始），无则为 undefined */
        readonly line: number | undefined,
        /** 列号（1 起始），无则为 undefined */
        readonly column: number | undefined,
        /** 提供链接时终端的 cwd，用于解析相对路径 */
        readonly cwd: vscode.Uri | undefined,
    ) {
        super(startIndex, length, tooltip);
    }
}

/** 常见源码/构建/配置文件的扩展名（用于识别路径 token） */
const FILE_EXT_RE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx|s|S|asm|mk|cmake|ino|py|sh|js|jsx|ts|tsx|json|txt|md|yml|yaml|log|ini|cfg|xml|java|go|rs|cs|m|mm|bat|cmd|ps1|o|obj|a|lib|so|dll|exe|out)$/i;

/** ANSI 转义序列（终端彩色输出） */
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** 引号包裹的内容："..." 或 '...'（路径含空格时），可后跟 :行号/:行列 后缀 */
const QUOTED_RE = /(["'])(.*?)\1((?::\d+(?::\d+)?)|(?:\(\d+,\s*\d+\)))?/g;

/** 未加引号的空白分隔 token */
const TOKEN_RE = /\S+/g;

/** 行号/行列后缀（容忍尾部无关标点）：:12、:12:5、：48、：48：5、(12)、(12,45) */
const SUFFIX_RE = /^(.*?)(?:(?:[:：])(\d+)(?:(?:[:：])(\d+))?|\((\d+)(?:,\s*(\d+))?\))[,:;\)\]\}>：:]*$/;

/** 对象文件扩展名（CMake 等构建产物，需裁剪为源文件） */
const OBJECT_EXT_RE = /\.(?:o|obj)$/i;

/** 解析后的路径信息 */
interface ParsedPath {
    path: string;
    line: number | undefined;
    column: number | undefined;
}

/** 链接条目（含原始行内位置） */
interface LinkEntry {
    start: number;
    end: number;
    parsed: ParsedPath;
}

/**
 * 从单个 token 中裁剪出路径与可选行号/列号。
 * 后缀正则自带尾部标点容忍（main.c:12:5: → main.c:12:5），
 * 无后缀时再去掉尾部无关标点（src/main.c, → src/main.c）。
 */
function parseToken(raw: string): ParsedPath | null {
    let t = raw.trim();
    if (!t) {
        return null;
    }
    // 去掉成对引号（引号分支已去，此处防御未加引号但残留引号的 token）
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
    }
    if (!t) {
        return null;
    }

    const m = t.match(SUFFIX_RE);
    if (m && m[1]) {
        const result: ParsedPath = { path: m[1], line: undefined, column: undefined };
        if (m[2] !== undefined) {
            result.line = Number(m[2]);
            if (m[3] !== undefined) {
                result.column = Number(m[3]);
            }
        } else {
            result.line = Number(m[4]);
            if (m[5] !== undefined) {
                result.column = Number(m[5]);
            }
        }
        return result;
    }
    // 无后缀：去掉尾部无关标点（含全角冒号）
    const stripped = t.replace(/[,;\)\]\}>:：]+$/, '');
    if (!stripped) {
        return null;
    }
    return { path: stripped, line: undefined, column: undefined };
}

/** 判断 p 是否为真实存在的文件 */
function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

/** 取路径的 basename（同时兼容 / 与 \ 分隔符） */
function basenameOf(p: string): string {
    const norm = p.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/');
    return idx >= 0 ? norm.slice(idx + 1) : norm;
}

/**
 * 规范化并去掉路径开头/中部的 . 与 .. 段。
 * 终端的 ../ 相对 cwd 向上，落到工作区做后缀匹配/磁盘直查时无意义，需剥掉。
 */
function stripDotSegments(p: string): string {
    return path.posix.normalize(p).replace(/^(?:\.\.\/)*/, '');
}

/** compile_commands.json 缓存：键=文件绝对路径，值=目录列表+mtime */
const ccCache = new Map<string, { mtimeMs: number; buildDirs: string[] }>();

/**
 * 收集各工作区根 compile_commands.json 中记录的构建目录（编译器实际运行目录）。
 * 编译器按该目录打印相对路径（如 ../COMMON/.../UserPref.c），用它解析即可命中正在编译的文件，
 * 终端未启用 shell 集成（拿不到 cwd）时的可靠替代。
 */
function getCompileCommandsBuildDirs(): string[] {
    const result: string[] = [];
    for (const wf of vscode.workspace.workspaceFolders ?? []) {
        const cc = path.join(wf.uri.fsPath, 'compile_commands.json');
        let st: fs.Stats;
        try {
            st = fs.statSync(cc);
        } catch {
            continue;
        }
        const cached = ccCache.get(cc);
        if (cached && cached.mtimeMs === st.mtimeMs) {
            result.push(...cached.buildDirs);
            continue;
        }
        const buildDirs: string[] = [];
        try {
            const raw = JSON.parse(fs.readFileSync(cc, 'utf8'));
            const seen = new Set<string>();
            if (Array.isArray(raw)) {
                for (const e of raw) {
                    if (e && typeof e.directory === 'string' && e.directory) {
                        const key = e.directory.toLowerCase();
                        if (!seen.has(key)) {
                            seen.add(key);
                            buildDirs.push(e.directory);
                        }
                    }
                }
            }
        } catch {
            // 解析失败按空处理，下次 mtime 变化再重试
        }
        ccCache.set(cc, { mtimeMs: st.mtimeMs, buildDirs });
        result.push(...buildDirs);
    }
    return result;
}

/**
 * 在磁盘上查找文件：
 * - ~ 展开为家目录
 * - 绝对路径直接判断
 * - 相对路径依次尝试终端 cwd、compile_commands.json 构建目录、各工作区根目录
 * - 带 ../ 的路径直接 join 可能对不上（cwd 层级比打印路径深），再试去掉 . ../ 段后的路径
 */
function findOnDisk(p: string, cwd: vscode.Uri | undefined): vscode.Uri | undefined {
    const candidates: string[] = [];
    if (p.startsWith('~')) {
        candidates.push(path.join(os.homedir(), p.slice(1)));
    } else if (/^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')) {
        candidates.push(p);
    } else {
        const norm = p.replace(/\\/g, '/');
        const stripped = stripDotSegments(norm);
        const seenBases = new Set<string>();
        const bases: string[] = [];
        const addBase = (b?: string): void => {
            if (b && !seenBases.has(b.toLowerCase())) {
                seenBases.add(b.toLowerCase());
                bases.push(b);
            }
        };
        addBase(cwd?.fsPath);
        for (const d of getCompileCommandsBuildDirs()) {
            addBase(d);
        }
        for (const wf of vscode.workspace.workspaceFolders ?? []) {
            addBase(wf.uri.fsPath);
        }
        for (const b of bases) {
            candidates.push(path.join(b, norm));
            if (stripped !== norm) {
                candidates.push(path.join(b, stripped));
            }
        }
    }
    for (const c of candidates) {
        if (isFile(c)) {
            return vscode.Uri.file(c);
        }
    }
    return undefined;
}

/** 判断 p 是否为磁盘上已存在的文件（用于提供链接前的快速过滤） */
function isExistingFile(p: string, cwd: vscode.Uri | undefined): boolean {
    return findOnDisk(p, cwd) !== undefined;
}

/**
 * 判断裁剪后的路径是否值得作为链接：
 * - 磁盘上已存在 → 链接
 * - CMake 构建产物（CMakeFiles/xxx.dir/...）→ 链接（点击时自动裁剪为源文件）
 * - 含目录分隔符且带常见扩展名 → 链接（编译输出中 cwd 之外的文件）
 * - 绝对/相对前缀且带扩展名 → 链接
 * - 带行号后缀的裸文件名（main.c:12、Makefile:99）→ 链接（编译诊断/grep 输出）
 *
 * @param hasLoc 是否带有行号/行列后缀
 */
function acceptLink(p: string, cwd: vscode.Uri | undefined, hasLoc: boolean): boolean {
    if (!p || p.includes('://')) {
        return false;
    }
    if (isExistingFile(p, cwd)) {
        return true;
    }
    if (/CMakeFiles[\\/]/.test(p) || /\.dir[\\/]/.test(p)) {
        return true;
    }
    const hasSep = p.includes('/') || p.includes('\\');
    const hasExt = FILE_EXT_RE.test(p);
    if (hasSep && hasExt) {
        return true;
    }
    const isAbs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('~');
    const isRel = /^\.{1,2}[\\/]/.test(p);
    if ((isAbs || isRel) && hasExt) {
        return true;
    }
    // 纯数字的"路径"（如 12:5）不是文件
    if (hasLoc && !/^\d+$/.test(basenameOf(p))) {
        return true;
    }
    return false;
}

/**
 * 从一行终端输出中提取所有路径链接。
 * 先在原始行上做位置匹配（兼容 ANSI 颜色码），再逐 token 裁剪路径。
 */
function extractLinks(rawLine: string, cwd: vscode.Uri | undefined): PathTerminalLink[] {
    // 去掉 ANSI 转义序列后再匹配（颜色码不影响位置计算之外的处理）
    const line = rawLine.replace(ANSI_RE, '');
    const entries: LinkEntry[] = [];

    // 1) 引号包裹的路径（允许含空格），可后跟 :行号/:行列 后缀
    for (const m of line.matchAll(QUOTED_RE)) {
        const idx = m.index ?? 0;
        const parsed = parseToken(m[2] + (m[3] ?? ''));
        if (!parsed) {
            continue;
        }
        const hasLoc = parsed.line !== undefined || parsed.column !== undefined;
        if (!acceptLink(parsed.path, cwd, hasLoc)) {
            continue;
        }
        entries.push({ start: idx, end: idx + m[0].length, parsed });
    }

    // 2) 未加引号的空白分隔 token
    for (const m of line.matchAll(TOKEN_RE)) {
        const idx = m.index ?? 0;
        // 跳过与已匹配的引号路径重叠的 token
        if (entries.some((e) => idx >= e.start && idx < e.end)) {
            continue;
        }
        const parsed = parseToken(m[0]);
        if (!parsed) {
            continue;
        }
        const hasLoc = parsed.line !== undefined || parsed.column !== undefined;
        if (!acceptLink(parsed.path, cwd, hasLoc)) {
            continue;
        }
        entries.push({ start: idx, end: idx + m[0].length, parsed });
    }

    return entries.map((e) => {
        const loc =
            e.parsed.line !== undefined
                ? `:${e.parsed.line}${e.parsed.column !== undefined ? `:${e.parsed.column}` : ''}`
                : '';
        return new PathTerminalLink(
            e.start,
            e.end - e.start,
            `打开: ${e.parsed.path}${loc}`,
            e.parsed.path,
            e.parsed.line,
            e.parsed.column,
            cwd,
        );
    });
}

/**
 * 裁剪 CMake/ninja 构建产物路径为源文件路径：
 * - CMakeFiles/xxx.dir/ 前缀
 * - build/、out/、Debug/、Release/ 等构建目录前缀
 * - .o/.obj 对象文件扩展名（main.c.o → main.c）
 */
function cropBuildArtifact(p: string): string {
    let s = p;
    // CMakeFiles/xxx.dir/ 前缀（可带任意前置目录）
    s = s.replace(/^(?:.*[\\/])?CMakeFiles[\\/][^/\\]+\.[^/\\]*dir[\\/]/i, '');
    // 路径中部的构建目录段（proj/build/main.c.o → proj/main.c.o），保留分隔符
    s = s.replace(/[\\/](?:build|Debug|Release|RelWithDebInfo|MinSizeRel|cmake-build[^\\/]*)[\\/]/i, '/');
    // 开头的构建目录段（build/main.c.o → main.c.o）
    s = s.replace(/^(?:build|out|bin|Debug|Release|RelWithDebInfo|MinSizeRel|cmake-build[^\\/]*)[\\/]/i, '');
    // 对象文件扩展名（main.c.o → main.c）
    s = s.replace(OBJECT_EXT_RE, '');
    return s;
}

/** 转义 glob 特殊字符（findFiles 使用） */
function escapeGlob(name: string): string {
    return name.replace(/([\[\]{}*?])/g, '\\$1');
}

/**
 * 在工作区中按文件名搜索全部匹配。
 * exclude 传 null：官方逃生口，无视 files.exclude / search.exclude / .gitignore，
 * 否则被 settings 排除的目录（如构建产物源文件）会搜不到。
 */
async function findAllInWorkspace(baseName: string): Promise<vscode.Uri[]> {
    if (!baseName || baseName === '.' || baseName === '..') {
        return [];
    }
    try {
        return await vscode.workspace.findFiles(`**/${escapeGlob(baseName)}`, null, 50);
    } catch {
        return [];
    }
}

/**
 * 对候选文件排序：
 * - 相对路径以目标后缀结尾（如 src/main.c）得分最高 → 构建输出通常保留源相对目录，可唯一锁定正在编译的文件
 * - 其次接近终端 cwd（正在编译的目录）优先
 */
function rankCandidates(
    uris: vscode.Uri[],
    relSuffix: string,
    cwd: vscode.Uri | undefined
): { uri: vscode.Uri; rel: string; score: number }[] {
    const cwdPath = cwd ? cwd.fsPath.replace(/\\/g, '/').toLowerCase() : '';
    const scored = uris.map((uri) => {
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const rel = folder
            ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/').toLowerCase()
            : path.basename(uri.fsPath).toLowerCase();
        let score = 0;
        if (relSuffix && rel.endsWith(relSuffix)) {
            score += 100;
        }
        if (cwdPath) {
            const abs = uri.fsPath.replace(/\\/g, '/').toLowerCase();
            if (abs.startsWith(cwdPath + '/')) {
                score += 40 - Math.min(20, abs.slice(cwdPath.length + 1).split('/').length);
            }
        }
        return { uri, rel, score };
    });
    scored.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
    return scored;
}

/** 多个同名候选歧义时弹出选择器让用户挑选（替代随机跳转） */
async function pickFromCandidates(uris: vscode.Uri[]): Promise<vscode.Uri | undefined> {
    const items = uris.map((uri) => ({
        label: basenameOf(uri.fsPath),
        description: vscode.workspace.asRelativePath(uri, true),
        uri,
    }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '存在多个同名文件，请选择要打开的文件',
        matchOnDescription: true,
    });
    return picked?.uri;
}

/**
 * 按文件名全工作区搜索并择优：
 * - 唯一候选或最高分唯一 → 直接采用
 * - 多个同等候选 → 弹出选择器让用户挑选
 */
async function resolveBySearch(target: string, cwd: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    const baseName = basenameOf(target);
    if (!baseName || baseName === '.' || baseName === '..') {
        return undefined;
    }
    const matches = await findAllInWorkspace(baseName);
    if (matches.length === 0) {
        return undefined;
    }
    // 后缀匹配前剥掉 . ../ 段（../COMMON/.../UserPref.c → COMMON/.../UserPref.c）
    const relSuffix = stripDotSegments(target.replace(/\\/g, '/')).toLowerCase();
    if (!relSuffix) {
        return undefined;
    }
    const ranked = rankCandidates(matches, relSuffix, cwd);
    if (ranked.length === 1 || ranked[0].score > ranked[1].score) {
        return ranked[0].uri;
    }
    return pickFromCandidates(ranked.map((r) => r.uri));
}

/**
 * 按源文件名搜索工作区（无视忽略设置）：
 * - 对象文件（.o/.obj）先取去掉扩展名的源文件名（foo.c.o → foo.c）
 * - 无扩展名的词干补充常见源码扩展名
 * - 相对路径保留目录段做后缀匹配（src/main.c.o → src/main.c）
 */
async function findSourceInWorkspace(p: string, cwd: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    const base = basenameOf(p);
    const stems: string[] = [];
    if (OBJECT_EXT_RE.test(base)) {
        const stem = base.replace(OBJECT_EXT_RE, '');
        stems.push(stem);
        if (!stem.includes('.')) {
            for (const ext of ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx']) {
                stems.push(`${stem}.${ext}`);
            }
        }
    } else {
        stems.push(base);
    }
    const normP = p.replace(/\\/g, '/');
    const isAbs = /^[A-Za-z]:[\\/]/.test(normP) || normP.startsWith('/') || normP.startsWith('~');
    const dir = isAbs ? '' : normP.slice(0, normP.lastIndexOf('/') + 1);
    for (const s of stems) {
        const found = await resolveBySearch(dir + s, cwd);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * 解析裁剪后的路径为可打开的文件 Uri：
 * 1. 磁盘直查（绝对/~ /相对 cwd/工作区根目录）
 * 2. CMake/ninja 构建产物裁剪后重试（含工作区搜索）
 * 3. 对象文件按源文件名搜索
 * 4. 工作区全量搜索（无视忽略设置，按相对路径后缀/就近 cwd 择优）
 */
async function resolveFileUri(filePath: string, cwd: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
    // 1) 磁盘直查
    const direct = findOnDisk(filePath, cwd);
    if (direct) {
        return direct;
    }

    // 2) 构建产物裁剪后重试
    const cropped = cropBuildArtifact(filePath);
    if (cropped !== filePath) {
        const direct2 = findOnDisk(cropped, cwd);
        if (direct2) {
            return direct2;
        }
        const viaBase = await findSourceInWorkspace(cropped, cwd);
        if (viaBase) {
            return viaBase;
        }
    }

    // 3) 对象文件：去掉扩展名后按源文件名搜索
    if (OBJECT_EXT_RE.test(filePath)) {
        const viaStem = await findSourceInWorkspace(filePath, cwd);
        if (viaStem) {
            return viaStem;
        }
    }

    // 4) 工作区全量搜索兜底（无视忽略设置）
    return resolveBySearch(filePath, cwd);
}

/** 打开文件并跳转到指定行/列 */
async function openInEditor(uri: vscode.Uri, line?: number, column?: number): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: true });
    if (line !== undefined) {
        const pos = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }
}

/** 点击链接：解析并打开文件；失败时提示（可回退到文件搜索栏，此时是裁剪后的干净路径） */
async function handleTerminalLink(link: vscode.TerminalLink): Promise<void> {
    if (!(link instanceof PathTerminalLink)) {
        return;
    }
    const { filePath, line, column, cwd } = link;
    const loc =
        line !== undefined
            ? `:${line}${column !== undefined ? `:${column}` : ''}`
            : '';
    debugLog(`点击终端路径: "${filePath}"${loc}`);
    try {
        const uri = await resolveFileUri(filePath, cwd);
        if (uri) {
            debugLog(`已定位: ${uri.fsPath}`);
            await openInEditor(uri, line, column);
            return;
        }
        const action = await vscode.window.showWarningMessage(
            `C Workflow: 未找到文件 "${filePath}"`,
            '在文件搜索中查找',
        );
        if (action === '在文件搜索中查找') {
            await vscode.commands.executeCommand('workbench.action.quickOpen', filePath);
        }
    } catch (err) {
        logError(`终端路径跳转失败: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * 注册终端路径链接提供器。
 * Ctrl+点击 终端中的文件路径时直接打开文件（裁剪路径 + 跳转行列），
 * 不再复制整行到文件搜索栏。
 */
export function registerTerminalLink(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = vscode.window.registerTerminalLinkProvider({
        provideTerminalLinks(
            ctx: vscode.TerminalLinkContext,
            _token: vscode.CancellationToken,
        ): vscode.ProviderResult<vscode.TerminalLink[]> {
            // cwd 来自 shell 集成（未启用 shell 集成为 undefined 时退回工作区根目录解析）
            return extractLinks(ctx.line, ctx.terminal.shellIntegration?.cwd);
        },
        handleTerminalLink(link: vscode.TerminalLink): vscode.ProviderResult<void> {
            return handleTerminalLink(link);
        },
    });
    context.subscriptions.push(provider);
    log('终端路径链接功能已注册（Ctrl+点击路径直接打开文件）');
    return provider;
}
