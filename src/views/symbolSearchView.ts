import * as vscode from 'vscode';
import { log } from '../outputChannel';
import { searchSymbols, SymbolKind } from '../features/symbolSearch';

/** 输入防抖间隔 */
const DEBOUNCE_MS = 200;
/** 结果列表最多渲染条数（避免 webview DOM 过大） */
const MAX_RENDER = 1000;

/** 搜索面板消息类型（webview <-> host） */
interface SearchMessage {
    type: 'search';
    keyword: string;
    symbolType: SymbolKind;
}

interface OpenMessage {
    type: 'open';
    file: string;
    line: number;
}

type WebviewMessage = SearchMessage | OpenMessage | { type: 'ready' };

/**
 * 侧边栏「符号搜索」面板：全局搜索 C/C++ 符号（函数/宏/变量/结构体/枚举）。
 * 符号类型由语言服务器（C/C++ 扩展）提供，点击结果跳转到定义处。
 */
export class SymbolSearchViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'c-workflow-tools.symbolSearchView';

    private view?: vscode.WebviewView;
    private searchToken?: vscode.CancellationTokenSource;

    constructor(private readonly extensionUri: vscode.Uri) {}

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            // 允许 webview 访问 media 目录（codicon 图标字体）
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
        };
        webviewView.webview.html = this.getHtml(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'search':
                    this.runSearch(msg.keyword, msg.symbolType);
                    break;
                case 'open':
                    this.openSymbol(msg.file, msg.line);
                    break;
                case 'ready':
                    log('[符号搜索] webview 已就绪');
                    break;
                default:
                    log(`[符号搜索] 收到未知消息: ${JSON.stringify(msg)}`);
            }
        });
    }

    /** 执行全局符号搜索（自动取消上一次未完成的搜索） */
    private async runSearch(keyword: string, symbolType: SymbolKind): Promise<void> {
        const view = this.view;
        if (!view) {
            return;
        }
        this.searchToken?.cancel();
        const token = new vscode.CancellationTokenSource();
        this.searchToken = token;

        const kw = keyword.trim();
        view.webview.postMessage({ type: 'searching', keyword: kw });

        const startTime = Date.now();
        let lastProgressSent = 0;
        try {
            const outcome = await searchSymbols(kw, symbolType, token.token, (p) => {
                // 节流进度上报，避免消息风暴
                const now = Date.now();
                if (now - lastProgressSent > 120 || p.scanned >= p.total) {
                    lastProgressSent = now;
                    if (!token.token.isCancellationRequested) {
                        view.webview.postMessage({ type: 'progress', scanned: p.scanned, total: p.total });
                    }
                }
            });
            if (token.token.isCancellationRequested) {
                return;
            }
            const elapsed = Date.now() - startTime;
            const truncated = outcome.results.length > MAX_RENDER;
            view.webview.postMessage({
                type: 'results',
                results: truncated ? outcome.results.slice(0, MAX_RENDER) : outcome.results,
                total: outcome.results.length,
                truncated,
                source: outcome.source,
                elapsed,
            });
        } catch (err) {
            if (token.token.isCancellationRequested) {
                return;
            }
            view.webview.postMessage({ type: 'error', message: String(err) });
        }
    }

    /** 打开结果文件并定位到符号所在行 */
    private async openSymbol(file: string, line: number): Promise<void> {
        const matches = await vscode.workspace.findFiles(file, undefined, 1);
        if (matches.length === 0) {
            vscode.window.showWarningMessage(`未找到文件：${file}`);
            return;
        }
        const doc = await vscode.workspace.openTextDocument(matches[0]);
        const editor = await vscode.window.showTextDocument(doc, { preview: true });
        const pos = new vscode.Position(line, 0);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(pos, pos);
    }

    private getHtml(webview: vscode.Webview): string {
        // codicon 图标字体（VS Code 内置大纲图标）
        const codiconsCss = webview.asWebviewUri(
            vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css')
        );
        const cspSource = webview.cspSource;
        // 界面文案跟随 VS Code UI 语言（zh 中文，其他英文）
        const zh = vscode.env.language.toLowerCase().startsWith('zh');
        const I = zh
            ? {
                  placeholder: '多词搜索，如 app turn on（匹配函数名含 app/turn/on）',
                  btnSearch: '搜索',
                  kindAll: '全部类型',
                  kindFunction: '函数',
                  kindMacro: '宏',
                  kindVariable: '变量',
                  kindStruct: '结构体',
                  kindEnum: '枚举',
                  statusInitial: '输入关键词回车搜索；不输入关键词则列出全部符号',
                  statusIdle: '输入关键词自动搜索；回车立即搜索；可切换类型筛选',
                  searching: '搜索中…',
                  searchingProgress: '搜索中…（',
                  parenL: '（',
                  parenR: '）',
                  srcLabel: '，来源：',
                  msComma: 'ms，',
                  srcWorkspace: '工作区索引',
                  srcDocument: '当前文档',
                  srcRegex: '正则扫描',
                  srcNone: '无来源',
                  notFound: '未找到匹配的符号',
                  totalPrefix: '共 ',
                  totalSuffix: ' 个符号',
                  truncatedPrefix: '（仅显示前 ',
                  truncatedSuffix: ' 个）',
                  errorPrefix: '搜索出错：',
                  emptyHint:
                      '未找到匹配的符号。\\n请确认：\\n1. 已安装并启用 C/C++ 扩展（ms-vscode.cpptools）\\n2. 工作区已建立符号索引（首次需等待）\\n3. 可运行命令「C Workflow: 诊断符号搜索」查看原因',
              }
            : {
                  placeholder: 'Multi-word search, e.g. app turn on',
                  btnSearch: 'Search',
                  kindAll: 'All types',
                  kindFunction: 'Function',
                  kindMacro: 'Macro',
                  kindVariable: 'Variable',
                  kindStruct: 'Struct',
                  kindEnum: 'Enum',
                  statusInitial: 'Type keywords and press Enter to search; empty lists all symbols',
                  statusIdle: 'Auto-search as you type; Enter to search now; switch type to filter',
                  searching: 'Searching…',
                  searchingProgress: 'Searching… (',
                  parenL: ' (',
                  parenR: ')',
                  srcLabel: ', source: ',
                  msComma: 'ms, ',
                  srcWorkspace: 'Workspace index',
                  srcDocument: 'Current document',
                  srcRegex: 'Regex scan',
                  srcNone: 'None',
                  notFound: 'No matching symbols',
                  totalPrefix: '',
                  totalSuffix: ' symbols',
                  truncatedPrefix: ' (showing first ',
                  truncatedSuffix: ')',
                  errorPrefix: 'Search error: ',
                  emptyHint:
                      'No matching symbols found.\\nPlease check:\\n1. C/C++ extension (ms-vscode.cpptools) is installed and enabled\\n2. Workspace symbol index is built (first time may take a while)\\n3. Run command "C Workflow: Diagnose Symbol Search" for details',
              };
        return /* html */ `<!DOCTYPE html>
<html lang="${zh ? 'zh-CN' : 'en'}">
<head>
<meta charset="UTF-8" />
<!-- CSP 必须显式声明，否则 VS Code 默认 CSP 会拦截内联脚本导致面板无响应 -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; script-src 'unsafe-inline'; img-src ${cspSource} data:;" />
<link rel="stylesheet" href="${codiconsCss}" />
<style>
    body {
        margin: 0;
        padding: 8px;
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        background: transparent;
    }
    .search-row {
        display: flex;
        gap: 4px;
        margin-bottom: 6px;
    }
    #keyword {
        flex: 1;
        min-width: 0;
        padding: 3px 6px;
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        outline: none;
    }
    #keyword:focus {
        border-color: var(--vscode-focusBorder);
    }
    #btn {
        padding: 3px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        border-radius: 2px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
    }
    #btn:hover {
        background: var(--vscode-button-hoverBackground);
    }
    /* 自定义下拉（原生 select 弹窗无法加动画，改为 div 模拟） */
    .dropdown {
        position: relative;
        flex: 1;
    }
    .dropdown-toggle {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 6px;
        padding: 3px 6px;
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        font: inherit;
        font-size: inherit;
        cursor: pointer;
    }
    .dropdown-toggle:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
    }
    .dropdown-arrow {
        font-size: 12px;
        transition: transform 150ms ease;
    }
    .dropdown.open .dropdown-arrow {
        transform: rotate(180deg);
    }
    .dropdown-menu {
        position: absolute;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        z-index: 10;
        margin: 0;
        padding: 2px 0;
        list-style: none;
        background: var(--vscode-dropdown-background, var(--vscode-input-background));
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-widget-border, transparent));
        border-radius: 3px;
        box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.3));
        opacity: 0;
        transform: translateY(-4px);
        visibility: hidden;
        transition: opacity 120ms ease, transform 120ms ease, visibility 120ms;
    }
    .dropdown.open .dropdown-menu {
        opacity: 1;
        transform: translateY(0);
        visibility: visible;
        transition: opacity 140ms ease, transform 140ms ease;
    }
    .dropdown-menu li {
        padding: 3px 10px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .dropdown-menu li:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .dropdown-menu li.selected {
        background: var(--vscode-list-activeSelectionBackground, transparent);
        color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }
    #status {
        margin: 2px 0 6px 0;
        font-size: 11px;
        color: var(--vscode-descriptionForeground);
        user-select: none;
    }
    #results {
        display: flex;
        flex-direction: column;
    }
    .result-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 4px;
        border-radius: 2px;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
    }
    .result-item:hover {
        background: var(--vscode-list-hoverBackground);
    }
    /* 符号类型图标：与 VS Code 大纲视图一致（codicon + 主题 symbolIcon 颜色） */
    .kind-icon {
        flex-shrink: 0;
        font-size: 15px;
        line-height: 1;
    }
    .kind-icon.k-function { color: var(--vscode-symbolIcon-functionForeground); }
    .kind-icon.k-macro { color: var(--vscode-symbolIcon-keywordForeground); }
    .kind-icon.k-variable { color: var(--vscode-symbolIcon-variableForeground); }
    .kind-icon.k-struct { color: var(--vscode-symbolIcon-structForeground); }
    .kind-icon.k-enum { color: var(--vscode-symbolIcon-enumForeground); }
    /* 符号名：必须完整显示，不收缩不省略 */
    .name {
        flex: 0 0 auto;
        font-weight: 600;
        white-space: nowrap;
    }
    /* 路径：右对齐显示；空间不足时保留尾部（前面省略号），随侧边栏宽度自适应 */
    .file {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        direction: rtl;
        text-align: right;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
    }
    .empty {
        padding: 12px 4px;
        text-align: center;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
    }
</style>
</head>
<body>
    <div class="search-row">
        <input id="keyword" type="text" placeholder="${I.placeholder}" spellcheck="false" />
        <button id="btn">${I.btnSearch}</button>
    </div>
    <div class="search-row">
        <div class="dropdown" id="kindDropdown">
            <button type="button" class="dropdown-toggle" id="kindToggle">
                <span id="kindLabel">${I.kindAll}</span>
                <i class="codicon codicon-chevron-down dropdown-arrow"></i>
            </button>
            <ul class="dropdown-menu" id="kindMenu">
                <li data-value="all">${I.kindAll}</li>
                <li data-value="function">${I.kindFunction}</li>
                <li data-value="macro">${I.kindMacro}</li>
                <li data-value="variable">${I.kindVariable}</li>
                <li data-value="struct">${I.kindStruct}</li>
                <li data-value="enum">${I.kindEnum}</li>
            </ul>
        </div>
    </div>
    <div id="status">${I.statusInitial}</div>
    <div id="results"></div>

<script>
    const vscode = acquireVsCodeApi();
    // 捕获脚本运行时错误并上报到 host 输出面板，便于排查
    window.addEventListener('error', (e) => {
        try { vscode.postMessage({ type: 'error', message: 'webview 脚本错误: ' + (e.message || 'unknown') }); } catch (_) { }
    });
    const input = document.getElementById('keyword');
    const btn = document.getElementById('btn');
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('results');
    // 当前类型筛选值（自定义下拉）
    let currentKind = 'all';

    // VS Code 内置大纲图标（codicon 符号系列）
    const KIND_ICON = { function: 'symbol-function', macro: 'symbol-keyword', variable: 'symbol-variable', struct: 'symbol-struct', enum: 'symbol-enum' };

    let debounceTimer = null;

    function resetStatus() {
        statusEl.textContent = '${I.statusIdle}';
    }

    function doSearch() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        vscode.postMessage({ type: 'search', keyword: input.value, symbolType: currentKind });
        statusEl.textContent = '${I.searching}';
    }

    btn.addEventListener('click', doSearch);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            doSearch();
        }
    });
    input.addEventListener('input', () => {
        // 输入非空才自动搜索；清空输入恢复初始提示（避免触发全工作区慢扫描）
        if (!input.value.trim()) {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
            }
            resultsEl.innerHTML = '';
            resetStatus();
            return;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(doSearch, ${DEBOUNCE_MS});
    });
    // 自定义下拉：类型筛选（带展开/收起动画）
    const kindDropdown = document.getElementById('kindDropdown');
    const kindToggle = document.getElementById('kindToggle');
    const kindLabel = document.getElementById('kindLabel');
    const kindMenu = document.getElementById('kindMenu');
    const KIND_LABEL = {
        all: '${I.kindAll}',
        function: '${I.kindFunction}',
        macro: '${I.kindMacro}',
        variable: '${I.kindVariable}',
        struct: '${I.kindStruct}',
        enum: '${I.kindEnum}',
    };

    function setKind(value) {
        currentKind = value;
        kindLabel.textContent = KIND_LABEL[value] || value;
        kindMenu.querySelectorAll('li').forEach((li) => {
            li.classList.toggle('selected', li.dataset.value === value);
        });
        // 切换类型：有关键词立即重搜，否则仅提示
        if (input.value.trim()) {
            doSearch();
        }
    }

    kindToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        kindDropdown.classList.toggle('open');
    });
    kindMenu.addEventListener('click', (e) => {
        const li = e.target.closest('li');
        if (!li) {
            return;
        }
        setKind(li.dataset.value);
        kindDropdown.classList.remove('open');
    });
    document.addEventListener('click', (e) => {
        if (!kindDropdown.contains(e.target)) {
            kindDropdown.classList.remove('open');
        }
    });
    kindToggle.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            kindDropdown.classList.remove('open');
        }
    });

    const SOURCE_LABEL = { workspace: '${I.srcWorkspace}', document: '${I.srcDocument}', regex: '${I.srcRegex}', none: '${I.srcNone}' };

    function render(msg) {
        const results = msg.results;
        resultsEl.innerHTML = '';
        if (results.length === 0) {
            statusEl.textContent = '${I.notFound}' + '${I.parenL}' +
                (msg.elapsed != null ? msg.elapsed + '${I.msComma}' : '') +
                '${I.srcLabel}' + SOURCE_LABEL[msg.source] + '${I.parenR}';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '${I.emptyHint}';
            empty.style.whiteSpace = 'pre-line';
            resultsEl.appendChild(empty);
            return;
        }
        const source = SOURCE_LABEL[msg.source] || msg.source;
        statusEl.textContent =
            '${I.totalPrefix}' + msg.total + '${I.totalSuffix}' +
            (msg.truncated ? '${I.truncatedPrefix}' + results.length + '${I.truncatedSuffix}' : '') +
            '${I.parenL}' + msg.elapsed + 'ms' + '${I.srcLabel}' + source + '${I.parenR}';
        for (const r of results) {
            const item = document.createElement('div');
            item.className = 'result-item';

            // 类型标记：VS Code 内置大纲图标（codicon），颜色随主题
            const icon = document.createElement('i');
            icon.className = 'codicon codicon-' + (KIND_ICON[r.kind] || 'symbol-method') + ' kind-icon k-' + r.kind;
            item.appendChild(icon);

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = r.detail ? r.detail + '::' + r.name : r.name;
            item.appendChild(name);

            // 路径：右对齐，宽度不足时省略前面保留尾部（…/xxx.ts）
            const file = document.createElement('span');
            file.className = 'file';
            file.textContent = r.file;
            file.title = r.file;
            item.appendChild(file);

            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'open', file: r.file, line: r.line });
            });
            resultsEl.appendChild(item);
        }
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'searching') {
            statusEl.textContent = '${I.searching}';
        } else if (msg.type === 'progress') {
            statusEl.textContent = '${I.searchingProgress}' + msg.scanned + '/' + msg.total + '${I.parenR}';
        } else if (msg.type === 'results') {
            render(msg);
        } else if (msg.type === 'error') {
            statusEl.textContent = '${I.errorPrefix}' + msg.message;
            resultsEl.innerHTML = '';
        }
    });

    vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
    }
}

/**
 * 注册活动栏侧边栏「符号搜索」视图。
 */
export function registerSymbolSearchView(context: vscode.ExtensionContext): void {
    const provider = new SymbolSearchViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SymbolSearchViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );
}
