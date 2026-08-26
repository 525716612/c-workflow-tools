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

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();

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

    private getHtml(): string {
        return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<!-- CSP 必须显式声明，否则 VS Code 默认 CSP 会拦截内联脚本导致面板无响应 -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
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
    select#kind {
        flex: 1;
        padding: 3px 6px;
        border: 1px solid var(--vscode-input-border, transparent);
        border-radius: 2px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        outline: none;
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
    .kind-badge {
        flex-shrink: 0;
        font-size: 10px;
        padding: 0 4px;
        border-radius: 3px;
        border: 1px solid currentColor;
        opacity: 0.9;
    }
    .name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
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
        <input id="keyword" type="text" placeholder="多词搜索，如 app turn on（匹配函数名含 app/turn/on）" spellcheck="false" />
        <button id="btn">搜索</button>
    </div>
    <div class="search-row">
        <select id="kind">
            <option value="all">全部类型</option>
            <option value="function">函数</option>
            <option value="macro">宏</option>
            <option value="variable">变量</option>
            <option value="struct">结构体</option>
            <option value="enum">枚举</option>
        </select>
    </div>
    <div id="status">输入关键词回车搜索；不输入关键词则列出全部符号</div>
    <div id="results"></div>

<script>
    const vscode = acquireVsCodeApi();
    // 捕获脚本运行时错误并上报到 host 输出面板，便于排查
    window.addEventListener('error', (e) => {
        try { vscode.postMessage({ type: 'error', message: 'webview 脚本错误: ' + (e.message || 'unknown') }); } catch (_) { }
    });
    const input = document.getElementById('keyword');
    const kindEl = document.getElementById('kind');
    const btn = document.getElementById('btn');
    const statusEl = document.getElementById('status');
    const resultsEl = document.getElementById('results');

    const KIND_LABEL = { function: '函数', macro: '宏', variable: '变量', struct: '结构体', enum: '枚举' };
    const KIND_COLOR = { function: '#4fc1ff', macro: '#d19a66', variable: '#98c379', struct: '#e5c07b', enum: '#61afef' };

    let debounceTimer = null;

    function resetStatus() {
        statusEl.textContent = '输入关键词自动搜索；回车立即搜索；可切换类型筛选';
    }

    function doSearch() {
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        vscode.postMessage({ type: 'search', keyword: input.value, symbolType: kindEl.value });
        statusEl.textContent = '搜索中…';
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
    kindEl.addEventListener('change', () => {
        // 切换类型：有关键词立即重搜，否则仅提示
        if (input.value.trim()) {
            doSearch();
        }
    });

    const SOURCE_LABEL = { workspace: '工作区索引', document: '当前文档', regex: '正则扫描', none: '无来源' };

    function render(msg) {
        const results = msg.results;
        resultsEl.innerHTML = '';
        if (results.length === 0) {
            statusEl.textContent = '未找到匹配的符号（' + (msg.elapsed != null ? msg.elapsed + 'ms，' : '') +
                '来源：' + SOURCE_LABEL[msg.source] + '）';
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '未找到匹配的符号。\\n请确认：\\n1. 已安装并启用 C/C++ 扩展（ms-vscode.cpptools）\\n2. 工作区已建立符号索引（首次需等待）\\n3. 可运行命令「C Workflow: 诊断符号搜索」查看原因';
            empty.style.whiteSpace = 'pre-line';
            resultsEl.appendChild(empty);
            return;
        }
        const source = SOURCE_LABEL[msg.source] || msg.source;
        statusEl.textContent =
            '共 ' + msg.total + ' 个符号' +
            (msg.truncated ? '（仅显示前 ' + results.length + ' 个）' : '') +
            '（' + msg.elapsed + 'ms，来源：' + source + '）';
        for (const r of results) {
            const item = document.createElement('div');
            item.className = 'result-item';

            const badge = document.createElement('span');
            badge.className = 'kind-badge';
            badge.textContent = KIND_LABEL[r.kind] || r.kind;
            badge.style.color = KIND_COLOR[r.kind] || '';
            item.appendChild(badge);

            const name = document.createElement('span');
            name.className = 'name';
            name.textContent = r.detail ? r.detail + '::' + r.name : r.name;
            item.appendChild(name);

            item.addEventListener('click', () => {
                vscode.postMessage({ type: 'open', file: r.file, line: r.line });
            });
            resultsEl.appendChild(item);
        }
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;
        if (msg.type === 'searching') {
            statusEl.textContent = '搜索中…';
        } else if (msg.type === 'progress') {
            statusEl.textContent = '搜索中…（' + msg.scanned + '/' + msg.total + '）';
        } else if (msg.type === 'results') {
            render(msg);
        } else if (msg.type === 'error') {
            statusEl.textContent = '搜索出错：' + msg.message;
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
    const provider = new SymbolSearchViewProvider();
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SymbolSearchViewProvider.viewType, provider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );
}
