import * as vscode from 'vscode';
import { log, logError } from '../outputChannel';

/** 可搜索的符号类型 */
export type SymbolKind = 'all' | 'function' | 'macro' | 'variable' | 'struct' | 'enum';

/** 搜索结果的来源 */
export type SearchSource = 'workspace' | 'document' | 'none';

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

/** 搜索整体结果 */
export interface SearchOutcome {
    results: SymbolResult[];
    /** 结果来源：workspace(#)/document/正则兜底 */
    source: SearchSource;
}

/**
 * 工作区符号搜索（#）最短查询词长度。
 * 过短查询（如单字符）会触发语言服务器对全索引做模糊匹配，返回海量符号，
 * 内存压力大，是压垮 cpptools 的高危操作（VS Code 内置 # 搜索即强制至少 3 字符）。
 * 不足长度时跳过一级，降级到二级 document。
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

/** 按类型过滤工作区符号搜索结果（来自 vscode.executeWorkspaceSymbolProvider） */
export function filterWorkspaceSymbols(
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
function withTimeout<T>(
    p: T | PromiseLike<T>,
    ms: number,
    token?: vscode.CancellationToken
): Promise<T | typeof TIMEOUT_SYMBOL> {
    return new Promise<T | typeof TIMEOUT_SYMBOL>((resolve, reject) => {
        let settled = false;
        const settle = (v: T | typeof TIMEOUT_SYMBOL) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        const timer = setTimeout(() => settle(TIMEOUT_SYMBOL), ms);
        // 取消即立即返回哨兵：executeWorkspaceSymbolProvider 命令不可取消，
        // 若不响应 token 取消，连续输入/切换类型会让 host 端长时间阻塞、请求在语言服务器端堆积
        const sub = token?.onCancellationRequested(() => settle(TIMEOUT_SYMBOL));
        Promise.resolve(p).then(
            (v) => settle(v),
            (err) => {
                if (!settled) {
                    settled = true;
                    reject(err);
                }
            }
        );
        // 结果确定后清理定时器与取消监听
        void Promise.resolve(p).then(
            () => {
                clearTimeout(timer);
                sub?.dispose();
            },
            () => {
                clearTimeout(timer);
                sub?.dispose();
            }
        );
    });
}

/** 已安装的 C/C++ 语言服务器扩展 ID（按激活优先级） */
const KNOWN_C_LANGUAGE_SERVERS = ['ms-vscode.cpptools', 'llvm-vs-code-extensions.vscode-clangd'];
/** 等待语言服务器就位的最长时间（毫秒） */
const LS_READY_TIMEOUT_MS = 15000;
/** 轮询等待 provider 注册的间隔（毫秒） */
const LS_POLL_INTERVAL_MS = 200;

/** 延时（毫秒） */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 确保工作区符号搜索的语言服务器就位。
 *
 * 符号搜索依赖语言服务器（如 ms-vscode.cpptools）注册 workspace symbol provider，
 * 而语言服务器扩展按需懒激活、且常在打开 C/C++ 文件后才启动：插件先被激活时，
 * 首次搜索可能遇到 provider 尚未注册、直接返回空导致误判「未找到」。此函数：
 *   1. 探测并主动激活已安装的 C/C++ 语言服务器扩展（激活幂等，已激活则跳过）；
 *   2. 轮询等待 workspace symbol provider 注册（最长 LS_READY_TIMEOUT_MS，可取消）；
 *   3. 仍无 provider 时返回 false，由调用方降级到打开文档/正则扫描。
 *
 * 运行时无 provider 枚举 API 时无法检测就位状态，直接返回 true 走命令路径
 * （executeWorkspaceSymbolProvider 自身有超时兜底，且语言服务器扩展已尝试激活）。
 *
 * @param token 取消令牌
 * @param onStatus 就位状态回调（用于在 UI 上提示「等待语言服务器…」）
 * @returns provider 已就位（或无法检测、交由命令路径）返回 true，否则 false
 */
async function ensureLanguageServerReady(
    token: vscode.CancellationToken,
    onStatus?: (message: string) => void
): Promise<boolean> {
    const hasEnumeration = getWorkspaceSymbolProviders() !== undefined;
    if (hasEnumeration && getWorkspaceSymbolProviders()!.length > 0) {
        return true;
    }
    // 1. 尝试激活已安装的 C/C++ 语言服务器扩展
    for (const id of KNOWN_C_LANGUAGE_SERVERS) {
        if (token.isCancellationRequested) {
            return false;
        }
        const ext = vscode.extensions.getExtension(id);
        if (ext && !ext.isActive) {
            onStatus?.(`正在启动语言服务器（${id}）…`);
            try {
                await ext.activate();
            } catch (err) {
                logError(`[符号搜索] 激活语言服务器 ${id} 失败: ${String(err)}`);
            }
        }
    }
    if (!hasEnumeration) {
        return true;
    }
    // 2. 轮询等待 provider 注册（语言服务器激活完成后注册 workspace symbol provider）
    const deadline = Date.now() + LS_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (token.isCancellationRequested) {
            return false;
        }
        if (getWorkspaceSymbolProviders()!.length > 0) {
            onStatus?.('语言服务器已就绪');
            return true;
        }
        await delay(LS_POLL_INTERVAL_MS);
    }
    onStatus?.('语言服务器等待超时，降级到打开文档/正则扫描');
    return false;
}

/**
 * 获取已注册的工作区符号 provider。
 *
 * vscode.languages.getWorkspaceSymbolProviders 并非官方 VS Code API
 * （1.x 全版本运行时均不存在，此前补的类型声明是误判），仅做特性检测：
 * 未来版本若提供则直调（token 可真正传给语言服务器，取消时经 LSP $/cancelRequest
 * 通知服务器终止搜索）；不提供时返回 undefined，由 searchWorkspaceSymbols
 * 降级到 vscode.executeWorkspaceSymbolProvider 命令。
 */
function getWorkspaceSymbolProviders(): vscode.WorkspaceSymbolProvider[] | undefined {
    const languagesApi = vscode.languages as unknown as {
        getWorkspaceSymbolProviders?: () => vscode.WorkspaceSymbolProvider[];
    };
    if (typeof languagesApi.getWorkspaceSymbolProviders === 'function') {
        return languagesApi.getWorkspaceSymbolProviders();
    }
    return undefined;
}

/**
 * 降级路径：通过 vscode.executeWorkspaceSymbolProvider 命令执行工作区符号搜索。
 *
 * 该命令不接受 CancellationToken（取消无效），连续输入时理论上仍可能堆积请求，
 * 因此：1) 查询词过短仍由调用方（searchWorkspaceSymbols）先拦截；
 * 2) 整体有 WS_SEARCH_TIMEOUT_MS 超时兜底，请求不无限挂起；
 * 3) token 已取消时直接返回，不发出请求。
 */
async function searchWorkspaceSymbolsViaCommand(
    query: string,
    token: vscode.CancellationToken
): Promise<{ infos: vscode.SymbolInformation[]; timedOut: boolean; skipped: boolean }> {
    if (token.isCancellationRequested) {
        return { infos: [], timedOut: false, skipped: false };
    }
    try {
        const v = await withTimeout(
            vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                query
            ),
            WS_SEARCH_TIMEOUT_MS,
            token
        );
        if (v === TIMEOUT_SYMBOL) {
            return { infos: [], timedOut: true, skipped: false };
        }
        const infos = Array.isArray(v) ? v : [];
        return { infos, timedOut: false, skipped: false };
    } catch (err) {
        logError(`[符号搜索] workspace symbol 命令异常: ${String(err)}`);
        return { infos: [], timedOut: false, skipped: false };
    }
}

/**
 * 一级：工作区符号搜索（#）。
 *
 * 优先直调 provider 并传入 token（取消真正生效，避免连续输入时请求在语言服务器端
 * 堆积压垮 cpptools）；运行时 API 不支持时降级到 executeWorkspaceSymbolProvider 命令
 * （不可取消，但保留最短查询长度拦截与整体超时兜底，见 searchWorkspaceSymbolsViaCommand）。
 * 查询词过短（< MIN_WS_QUERY_LEN）时跳过，避免全索引模糊匹配风暴。
 *
 * @param query 查询词（已按单个关键词提取）
 * @param token 取消令牌
 * @returns infos 已取回的结果；timedOut 是否超时；skipped 是否因查询词过短而跳过
 */
export async function searchWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken,
    onStatus?: (message: string) => void
): Promise<{ infos: vscode.SymbolInformation[]; timedOut: boolean; skipped: boolean }> {
    if (query.length < MIN_WS_QUERY_LEN) {
        return { infos: [], timedOut: false, skipped: true };
    }
    // 语言服务器可能尚未就位（扩展未激活 / provider 未注册），先等待就位再搜索，
    // 避免首次搜索因 provider 未注册而空手降级
    const ready = await ensureLanguageServerReady(token, onStatus);
    if (!ready) {
        return { infos: [], timedOut: false, skipped: false };
    }
    const providers = getWorkspaceSymbolProviders();
    if (providers === undefined) {
        return searchWorkspaceSymbolsViaCommand(query, token);
    }
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
            const v = await withTimeout(provider.provideWorkspaceSymbols(query, token), remaining, token);
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
 * 两级链路，逐级降级：
 *   1. workspace：vscode.executeWorkspaceSymbolProvider（# 全局符号，走语言服务器索引）。
 *      多词关键词取第一个词查询，本地再做多词 AND 过滤。
 *   2. document：当前打开文档的 DocumentSymbol（语言服务器必然有数据）。
 * 两级均无结果时返回空（不再正则兜底，避免大工作区扫描卡顿）。
 * 每级耗时与结果数记录到输出通道，便于诊断。
 *
 * @param keyword     关键词（空串表示不限定）
 * @param kind        符号类型（'all' 表示全部类型）
 * @param token       取消令牌
 * @param onStatus    状态回调（等待语言服务器就位等提示，可空）
 * @param onWorkspaceRaw 一级 workspace 原始结果回调（非空时触发，供调用方缓存，
 *                       用于切换类型时本地过滤，避免重复慢搜索；可空）
 */
export async function searchSymbols(
    keyword: string,
    kind: SymbolKind,
    token: vscode.CancellationToken,
    onStatus?: (message: string) => void,
    onWorkspaceRaw?: (infos: vscode.SymbolInformation[]) => void
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
    // 说明：优先直调 provider 并传入 token（取消真正生效，避免连续输入时请求在语言服务器
    // 端堆积压垮 cpptools）；getWorkspaceSymbolProviders 非官方 API，运行时不存在时降级到
    // vscode.executeWorkspaceSymbolProvider 命令（不可取消，但有最短查询长度与整体超时
    // 兜底）。详见 searchWorkspaceSymbols。
    if (query) {
        const t0 = Date.now();
        const ws = await searchWorkspaceSymbols(query, token, onStatus);
        if (ws.infos.length > 0) {
            onWorkspaceRaw?.(ws.infos);
        }
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
            // （多词 AND 或类型筛选不匹配），继续降级到二级，否则会假"未找到"。
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

    // 语言服务器（workspace + document）均无结果：不再正则兜底，直接返回空
    log('[符号搜索] 语言服务器无结果，返回空');
    return { results: [], source: 'none' };
}
