import * as vscode from 'vscode';
import { log, logError } from '../outputChannel';

/** 可搜索的符号类型 */
export type SymbolKind = 'all' | 'function' | 'macro' | 'variable' | 'struct' | 'enum';

/** 搜索结果的来源 */
export type SearchSource = 'workspace' | 'document' | 'regex' | 'none';

/** 单个搜索结果 */
export interface SymbolResult {
    name: string;
    kind: Exclude<SymbolKind, 'all'>;
    /** 工作区内相对路径 */
    file: string;
    /** 行号（0-based） */
    line: number;
    /** 附加信息（如所在类/命名空间） */
    detail?: string;
}

/** 搜索进度回调 */
export interface SearchProgress {
    scanned: number;
    total: number;
}

/** 搜索整体结果 */
export interface SearchOutcome {
    results: SymbolResult[];
    /** 结果来源：workspace(#)/document/正则兜底 */
    source: SearchSource;
}

/** 默认扫描的 C/C++ 源文件扩展名 */
const DEFAULT_INCLUDE = '**/*.{c,h,cpp,hpp,cc,cxx,hh}';
/** 排除的目录 */
const DEFAULT_EXCLUDE = '**/{node_modules,.git,out,dist,build}/**';
/** 结果上限 */
const MAX_RESULTS = 5000;
/** 扫描文件数上限 */
const MAX_FILES = 20000;
/**
 * 工作区符号搜索（#）最短查询词长度。
 * 过短查询（如单字符）会触发语言服务器对全索引做模糊匹配，返回海量符号，
 * 内存压力大，是压垮 cpptools 的高危操作（VS Code 内置 # 搜索即强制至少 3 字符）。
 * 不足长度时跳过一级，降级到二级 document / 三级 regex。
 */
const MIN_WS_QUERY_LEN = 2;
/** 单次工作区符号搜索超时（ms）：语言服务器卡住时不无限等待 */
const WS_SEARCH_TIMEOUT_MS = 15000;

/* ------------------------------------------------------------------ */
/* 语言服务器（ms-vscode.cpptools 等）SymbolKind -> 类别映射            */
/* 这是符号类型筛选的权威来源：cpptools 中 #define 映射为 Constant 等    */
/* ------------------------------------------------------------------ */
const LS_KIND_MAP: Record<vscode.SymbolKind, Exclude<SymbolKind, 'all'> | undefined> = {
    [vscode.SymbolKind.File]: undefined,
    [vscode.SymbolKind.Module]: undefined,
    [vscode.SymbolKind.Namespace]: undefined,
    [vscode.SymbolKind.Package]: undefined,
    [vscode.SymbolKind.Class]: 'struct',
    [vscode.SymbolKind.Method]: 'function',
    [vscode.SymbolKind.Property]: 'variable',
    [vscode.SymbolKind.Field]: 'variable',
    [vscode.SymbolKind.Constructor]: 'function',
    [vscode.SymbolKind.Enum]: 'enum',
    [vscode.SymbolKind.Interface]: 'struct',
    [vscode.SymbolKind.Function]: 'function',
    [vscode.SymbolKind.Variable]: 'variable',
    [vscode.SymbolKind.Constant]: 'macro', // cpptools：#define 归为常量
    [vscode.SymbolKind.String]: undefined,
    [vscode.SymbolKind.Number]: undefined,
    [vscode.SymbolKind.Boolean]: undefined,
    [vscode.SymbolKind.Array]: undefined,
    [vscode.SymbolKind.Object]: undefined,
    [vscode.SymbolKind.Key]: undefined,
    [vscode.SymbolKind.Null]: undefined,
    [vscode.SymbolKind.EnumMember]: 'enum',
    [vscode.SymbolKind.Struct]: 'struct',
    [vscode.SymbolKind.Event]: undefined,
    [vscode.SymbolKind.Operator]: undefined,
    [vscode.SymbolKind.TypeParameter]: undefined,
};

/**
 * 多词匹配：keyword 按空白分词，每个词（忽略大小写）都需出现在 name 中。
 * 如 "app turn on" 可匹配 AppPanel_TurnOn / appTurnOnPanel 等。
 */
function keywordsMatch(name: string, keyword: string): boolean {
    const terms = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
        return true;
    }
    const lowerName = name.toLowerCase();
    return terms.every((t) => lowerName.includes(t));
}

/** 收集 DocumentSymbol 树（含子节点，如类内方法/成员） */
function collectDocumentSymbols(
    symbols: readonly vscode.DocumentSymbol[],
    relPath: string,
    kinds: Set<Exclude<SymbolKind, 'all'>>,
    keyword: string,
    results: SymbolResult[],
    seen: Set<string>
): void {
    for (const s of symbols) {
        const k = LS_KIND_MAP[s.kind];
        if (k && kinds.has(k)) {
            if (keywordsMatch(s.name, keyword)) {
                const key = `${k}:${s.name}:${relPath}:${s.selectionRange.start.line}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    results.push({
                        name: s.name,
                        kind: k,
                        file: relPath,
                        line: s.selectionRange.start.line,
                        detail: s.detail,
                    });
                }
            }
        }
        if (s.children && s.children.length > 0) {
            collectDocumentSymbols(s.children, relPath, kinds, keyword, results, seen);
        }
    }
}

/** 收集扁平 SymbolInformation 列表 */
function collectSymbolInformations(
    infos: readonly vscode.SymbolInformation[],
    relPath: string,
    kinds: Set<Exclude<SymbolKind, 'all'>>,
    keyword: string,
    results: SymbolResult[],
    seen: Set<string>
): void {
    for (const s of infos) {
        const k = LS_KIND_MAP[s.kind];
        if (!k || !kinds.has(k)) {
            continue;
        }
        if (!keywordsMatch(s.name, keyword)) {
            continue;
        }
        const line = s.location.range.start.line;
        const key = `${k}:${s.name}:${relPath}:${line}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push({ name: s.name, kind: k, file: relPath, line, detail: s.containerName });
    }
}

/* ------------------------------------------------------------------ */
/* 兜底：正则扫描（无语言服务器时使用，类型识别有限）                     */
/* ------------------------------------------------------------------ */
const MACRO_REGEX = /^\s*#\s*define\s+([A-Za-z_]\w*)/;
const STRUCT_REGEX = /^\s*(?:typedef\s+)?struct\s+([A-Za-z_]\w*)\s*\{/;
const ENUM_REGEX = /^\s*(?:typedef\s+)?enum\s+([A-Za-z_]\w*)\s*\{/;
const FUNCTION_REGEX =
    /^\s*(?!(?:if|for|while|switch|do|return|sizeof|else|case)\b)[\w\s\*&]+\s+(?:\*+\s*)*([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(\{|$)/;
const STORAGE_VAR_REGEX =
    /^\s*(?:static|extern|const|volatile|register)\s+(?:(?:unsigned|signed|short|long)\s+)*(?:[\w]+\s+)+(?:\*\s*)*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?[=;,]/;
const TOP_VAR_REGEX = /^[A-Za-z_](?:\w*\s+)+(?:\*\s*)*([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)?[=;,]/;

function classifyRegexLine(line: string): { kind: Exclude<SymbolKind, 'all'>; name: string } | null {
    let m = line.match(MACRO_REGEX);
    if (m) {
        return { kind: 'macro', name: m[1] };
    }
    m = line.match(STRUCT_REGEX);
    if (m) {
        return { kind: 'struct', name: m[1] };
    }
    m = line.match(ENUM_REGEX);
    if (m) {
        return { kind: 'enum', name: m[1] };
    }
    m = line.match(FUNCTION_REGEX);
    if (m) {
        return { kind: 'function', name: m[1] };
    }
    m = line.match(STORAGE_VAR_REGEX) || line.match(TOP_VAR_REGEX);
    if (m) {
        return { kind: 'variable', name: m[1] };
    }
    return null;
}

function buildMatchRegex(kinds: Array<Exclude<SymbolKind, 'all'>>): RegExp {
    const branches: string[] = [];
    if (kinds.includes('macro')) {
        branches.push('#\\s*define\\s+\\w+');
    }
    if (kinds.includes('struct')) {
        branches.push('(?:typedef\\s+)?struct\\s+\\w+\\s*\\{');
    }
    if (kinds.includes('enum')) {
        branches.push('(?:typedef\\s+)?enum\\s+\\w+\\s*\\{');
    }
    if (kinds.includes('function')) {
        branches.push('(?!(?:if|for|while|switch|do|return|sizeof|else|case)\\b)[\\w\\s\\*&]+\\s+(?:\\*+\\s*)*\\w+\\s*\\([^;{}]*\\)\\s*(?:\\{|$)');
    }
    if (kinds.includes('variable')) {
        branches.push(
            '(?:static|extern|const|volatile|register)\\s+(?:(?:unsigned|signed|short|long)\\s+)*(?:[\\w]+\\s+)+(?:\\*\\s*)*\\w+\\s*(?:\\[[^\\]]*\\]\\s*)?[=;,]'
        );
        branches.push('^[A-Za-z_](?:\\w*\\s+)+(?:\\*\\s*)*\\w+\\s*(?:\\[[^\\]]*\\]\\s*)?[=;,]');
    }
    if (!branches.length) {
        return /$^/;
    }
    return new RegExp(`^\\s*(?:${branches.join('|')})`, 'm');
}

/** 正则兜底扫描 */
async function searchSymbolsByRegex(
    keyword: string,
    kind: SymbolKind,
    token: vscode.CancellationToken,
    onProgress?: (p: SearchProgress) => void
): Promise<SymbolResult[]> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return [];
    }
    const kinds: Array<Exclude<SymbolKind, 'all'>> =
        kind === 'all' ? ['function', 'macro', 'variable', 'struct', 'enum'] : [kind];
    const matchRegex = buildMatchRegex(kinds);
    const lowerKeyword = keyword.trim().toLowerCase();

    const files = await vscode.workspace.findFiles(DEFAULT_INCLUDE, DEFAULT_EXCLUDE, MAX_FILES, token);
    const total = files.length;
    const results: SymbolResult[] = [];
    const seen = new Set<string>();
    const decoder = new TextDecoder('utf-8');

    for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested || results.length >= MAX_RESULTS) {
            break;
        }
        const file = files[i];
        let text: string;
        try {
            text = decoder.decode(await vscode.workspace.fs.readFile(file));
        } catch {
            continue;
        }
        if (!matchRegex.test(text)) {
            onProgress?.({ scanned: i + 1, total });
            continue;
        }
        const relPath = vscode.workspace.asRelativePath(file);
        const lines = text.split(/\r?\n/);
        for (let li = 0; li < lines.length; li++) {
            if (token.isCancellationRequested || results.length >= MAX_RESULTS) {
                break;
            }
            const line = lines[li];
            if (!matchRegex.test(line)) {
                continue;
            }
            const sym = classifyRegexLine(line);
            if (!sym || !kinds.includes(sym.kind)) {
                continue;
            }
            if (!keywordsMatch(sym.name, lowerKeyword)) {
                continue;
            }
            const key = `${sym.kind}:${sym.name}:${relPath}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            results.push({ name: sym.name, kind: sym.kind, file: relPath, line: li });
        }
        onProgress?.({ scanned: i + 1, total });
    }

    results.sort((a, b) => {
        if (a.file !== b.file) {
            return a.file.localeCompare(b.file);
        }
        return a.line - b.line;
    });
    return results;
}

/** 按类型过滤工作区符号搜索结果（来自 vscode.executeWorkspaceSymbolProvider） */
function filterWorkspaceSymbols(
    infos: readonly vscode.SymbolInformation[],
    kinds: Set<Exclude<SymbolKind, 'all'>>,
    lowerKw: string
): SymbolResult[] {
    const results: SymbolResult[] = [];
    const seen = new Set<string>();
    for (const s of infos) {
        const k = LS_KIND_MAP[s.kind];
        if (!k || !kinds.has(k)) {
            continue;
        }
        if (!keywordsMatch(s.name, lowerKw)) {
            continue;
        }
        const relPath = vscode.workspace.asRelativePath(s.location.uri);
        const line = s.location.range.start.line;
        const key = `${k}:${s.name}:${relPath}:${line}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        results.push({ name: s.name, kind: k, file: relPath, line, detail: s.containerName });
    }
    results.sort((a, b) => {
        if (a.file !== b.file) {
            return a.file.localeCompare(b.file);
        }
        return a.line - b.line;
    });
    return results;
}

/**
 * 提取传给语言服务器工作区符号搜索的查询词。
 * cpptools 的 # 符号搜索只接受单个关键词的模糊匹配，多词（如 "app turn on"）
 * 会被空格破坏导致返回空；因此取第一个词查询，多词 AND 过滤在本地完成。
 */
function extractWorkspaceQuery(keyword: string): string {
    const trimmed = keyword.trim();
    return trimmed.split(/\s+/)[0] ?? '';
}

/** withTimeout 超时哨兵值 */
const TIMEOUT_SYMBOL = Symbol('ws-search-timeout');

/**
 * 给 Promise 加超时；超时返回 TIMEOUT_SYMBOL（调用方据此放弃等待）。
 * @param p 原始 Promise（ProviderResult 可能是同步值或 thenable）
 * @param ms 超时毫秒数
 */
function withTimeout<T>(p: T | PromiseLike<T>, ms: number): Promise<T | typeof TIMEOUT_SYMBOL> {
    return new Promise<T | typeof TIMEOUT_SYMBOL>((resolve, reject) => {
        const timer = setTimeout(() => resolve(TIMEOUT_SYMBOL), ms);
        Promise.resolve(p).then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (err) => {
                clearTimeout(timer);
                reject(err);
            }
        );
    });
}

/**
 * 一级：工作区符号搜索（#）。
 *
 * 重要：不使用 vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', query)。
 * 该命令不接受 CancellationToken，取消令牌对它无效；输入防抖期间连续触发搜索时，
 * 已发出的请求无法终止，会在语言服务器端堆积（尤其短查询触发全索引模糊匹配），
 * 可能把 cpptools 等服务器进程压垮。
 *
 * 改为直接调用 vscode.languages.getWorkspaceSymbolProviders() 返回的 provider：
 *   - token 可真正传给语言服务器，取消时经 LSP $/cancelRequest 通知服务器终止搜索；
 *   - 查询词过短（< MIN_WS_QUERY_LEN）时跳过，避免全索引匹配风暴；
 *   - 单次搜索有整体超时兜底，服务器卡死时不无限等待。
 *
 * @param query 查询词（已按单个关键词提取）
 * @param token 取消令牌
 * @returns infos 已取回的结果；timedOut 是否超时；skipped 是否因查询词过短而跳过
 */
export async function searchWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken
): Promise<{ infos: vscode.SymbolInformation[]; timedOut: boolean; skipped: boolean }> {
    if (query.length < MIN_WS_QUERY_LEN) {
        return { infos: [], timedOut: false, skipped: true };
    }
    const providers = vscode.languages.getWorkspaceSymbolProviders();
    if (providers.length === 0) {
        return { infos: [], timedOut: false, skipped: false };
    }
    const infos: vscode.SymbolInformation[] = [];
    const t0 = Date.now();
    let timedOut = false;
    for (const provider of providers) {
        if (token.isCancellationRequested) {
            return { infos, timedOut: false, skipped: false };
        }
        const remaining = WS_SEARCH_TIMEOUT_MS - (Date.now() - t0);
        if (remaining <= 0) {
            timedOut = true;
            break;
        }
        let r: vscode.SymbolInformation[] | null | undefined;
        try {
            const v = await withTimeout(provider.provideWorkspaceSymbols(query, token), remaining);
            if (v === TIMEOUT_SYMBOL) {
                timedOut = true;
                break;
            }
            r = v;
        } catch (err) {
            logError(`[符号搜索] workspace symbol provider 异常: ${String(err)}`);
            r = undefined;
        }
        if (r) {
            infos.push(...r);
        }
    }
    return { infos, timedOut, skipped: false };
}

/**
 * 搜索当前已打开文档中的符号（DocumentSymbol）。
 * 语言服务器对打开文档必然有数据，秒回，无需读盘；
 * 作为 workspace symbol 返回空/不可用时的二级兜底。
 */
async function searchOpenDocuments(
    kinds: Set<Exclude<SymbolKind, 'all'>>,
    keyword: string,
    token: vscode.CancellationToken
): Promise<{ results: SymbolResult[]; used: boolean }> {
    const results: SymbolResult[] = [];
    const seen = new Set<string>();
    let used = false;

    const docs = vscode.window.visibleTextEditors
        .map((e) => e.document)
        .filter((d) => d.languageId === 'c' || d.languageId === 'cpp' || d.languageId === 'cuda-cpp');

    for (const doc of docs) {
        if (token.isCancellationRequested) {
            break;
        }
        let symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | null | undefined;
        try {
            symbols = await vscode.languages.executeDocumentSymbolProvider(doc.uri, token);
        } catch {
            symbols = undefined;
        }
        if (!symbols || symbols.length === 0) {
            continue;
        }
        used = true;
        const relPath = vscode.workspace.asRelativePath(doc.uri);
        if (symbols[0] instanceof vscode.DocumentSymbol) {
            collectDocumentSymbols(symbols as vscode.DocumentSymbol[], relPath, kinds, keyword, results, seen);
        } else {
            collectSymbolInformations(
                symbols as vscode.SymbolInformation[],
                relPath,
                kinds,
                keyword,
                results,
                seen
            );
        }
    }
    return { results, used };
}

/**
 * 全局搜索符号。
 *
 * 三级链路，逐级降级，保证有结果：
 *   1. workspace：vscode.executeWorkspaceSymbolProvider（# 全局符号，走语言服务器索引）。
 *      多词关键词取第一个词查询，本地再做多词 AND 过滤。
 *   2. document：当前打开文档的 DocumentSymbol（语言服务器必然有数据）。
 *   3. regex：全工作区正则行扫描兜底（无语言服务器时）。
 * 每级耗时与结果数记录到输出通道，便于诊断。
 *
 * @param keyword     关键词（空串表示不限定）
 * @param kind        符号类型（'all' 表示全部类型）
 * @param token       取消令牌
 * @param onProgress  扫描进度回调（正则兜底时上报）
 */
export async function searchSymbols(
    keyword: string,
    kind: SymbolKind,
    token: vscode.CancellationToken,
    onProgress?: (p: SearchProgress) => void
): Promise<SearchOutcome> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        log('[符号搜索] 无打开的工作区');
        return { results: [], source: 'none' };
    }

    const kinds = new Set<Exclude<SymbolKind, 'all'>>(
        kind === 'all' ? ['function', 'macro', 'variable', 'struct', 'enum'] : [kind]
    );
    const lowerKw = keyword.trim().toLowerCase();
    const query = extractWorkspaceQuery(keyword);

    log(`[符号搜索] 关键词="${keyword}" 查询词="${query}" 类型=${kind}`);

    // 一级：工作区符号搜索（#）
    // 说明：不直接执行 vscode.executeWorkspaceSymbolProvider 命令（不可取消，连续输入会
    // 向语言服务器堆积无法终止的搜索请求，可能压垮 cpptools）。改用 provider API 直调并
    // 传入 token（取消真正生效），另加最短查询长度与整体超时保护，详见 searchWorkspaceSymbols。
    if (query) {
        const t0 = Date.now();
        const ws = await searchWorkspaceSymbols(query, token);
        const elapsed = Date.now() - t0;
        if (ws.skipped) {
            log(
                `[符号搜索] 一级 workspace symbol: 查询词过短（<${MIN_WS_QUERY_LEN} 字符），` +
                    `跳过语言服务器搜索以避全索引匹配（耗时 ${elapsed}ms）`
            );
        } else if (ws.timedOut) {
            logError(
                `[符号搜索] 一级 workspace symbol: 超过 ${WS_SEARCH_TIMEOUT_MS}ms 未完成，放弃等待（耗时 ${elapsed}ms，已取回 ${ws.infos.length} 条）`
            );
            // 超时前可能已从部分 provider 取回结果，先尝试使用
            const results = filterWorkspaceSymbols(ws.infos, kinds, lowerKw);
            if (results.length > 0) {
                return { results, source: 'workspace' };
            }
        } else {
            const results = filterWorkspaceSymbols(ws.infos, kinds, lowerKw);
            log(
                `[符号搜索] 一级 workspace symbol: 耗时 ${elapsed}ms, ` +
                    `原始 ${ws.infos.length} 条, 过滤后 ${results.length} 条`
            );
            // 注意：必须仅在过滤后 results 非空时返回。若原始有数据但过滤后为空
            // （多词 AND 或类型筛选不匹配），继续降级到二级/三级，否则会假"未找到"。
            if (results.length > 0) {
                return { results, source: 'workspace' };
            }
            if (ws.infos.length > 0) {
                log(`[符号搜索] 一级原始 ${ws.infos.length} 条但本地过滤后为空，继续降级`);
            }
        }
    }

    // 二级：打开文档的 document symbol
    const t1 = Date.now();
    const doc = await searchOpenDocuments(kinds, keyword, token);
    if (doc.used) {
        log(
            `[符号搜索] 二级 document symbol: 耗时 ${Date.now() - t1}ms, ` +
                `打开文档 ${vscode.window.visibleTextEditors.length} 个, 结果 ${doc.results.length} 条`
        );
        if (doc.results.length > 0) {
            return { results: doc.results, source: 'document' };
        }
    }

    // 三级：正则全工作区扫描
    const t2 = Date.now();
    const fallback = await searchSymbolsByRegex(keyword, kind, token, onProgress);
    log(`[符号搜索] 三级 正则扫描: 耗时 ${Date.now() - t2}ms, 结果 ${fallback.length} 条`);
    return { results: fallback, source: fallback.length > 0 ? 'regex' : 'none' };
}
