import * as vscode from 'vscode';
import { selectMacroBlock } from './features/selectMacroBlock';
import { gitDifftoolCompare } from './features/gitDifftool';
import { packageDiff } from './features/packageDiff';
import { diagnoseSymbolSearch } from './features/symbolSearchDiagnose';

/**
 * 命令注册中心（可扩展点）。
 * 新增功能时，在此文件添加一行 registerCommand 即可，
 * 功能逻辑保持独立在 features/ 目录下各自文件中。
 */
export function registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        // 功能1：C 宏块快捷选中
        vscode.commands.registerCommand('c-workflow-tools.selectMacroBlock', () => {
            selectMacroBlock();
        }),

        // 功能2：Git 任意两节点 difftool 对比
        vscode.commands.registerCommand('c-workflow-tools.gitDifftoolCompare', () => {
            gitDifftoolCompare();
        }),

        // 功能3：打包两节点间差异文件
        vscode.commands.registerCommand('c-workflow-tools.packageDiff', () => {
            packageDiff();
        }),

        // 功能4：诊断符号搜索（语言服务器状态与搜索统计）
        vscode.commands.registerCommand('c-workflow-tools.diagnoseSymbolSearch', () => {
            diagnoseSymbolSearch();
        })
    );
}
