/**
 * 类型补充声明。
 *
 * 本项目 node_modules/@types/vscode 的 index.d.ts 被裁剪，缺少部分
 * 官方 VS Code API 的类型声明（运行时 API 完整存在，仅类型缺失）：
 *   - vscode.languages.executeDocumentSymbolProvider
 *   - vscode.workspace.findTextInFiles
 *
 * 通过 declare module 合并，补齐缺失的类型。
 */
declare module 'vscode' {
    export namespace languages {
        /**
         * 获取文档符号（DocumentSymbol 树或扁平 SymbolInformation 列表）。
         * 由语言服务器实现（如 ms-vscode.cpptools）。
         */
        export function executeDocumentSymbolProvider(
            uri: Uri,
            token?: CancellationToken
        ): ProviderResult<DocumentSymbol[] | SymbolInformation[]>;
    }
}
