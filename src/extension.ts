import * as vscode from 'vscode';
import { registerCommands } from './registerCommands';
import { registerDoubleClickMacroSelection } from './features/selectMacroBlock';
import { registerWorkflowView } from './views/workflowView';
import { registerSymbolSearchView } from './views/symbolSearchView';
import { registerTerminalLink } from './features/terminalLink';
import { initOutputChannel } from './outputChannel';

/**
 * 插件激活入口。
 * 只负责初始化基础设施（输出通道、命令注册、事件监听、侧边栏视图），
 * 所有功能逻辑均在 features/ 目录独立文件中实现。
 */
export function activate(context: vscode.ExtensionContext) {
    // 初始化全局输出通道
    initOutputChannel('C Workflow Tools');
    console.log('C Workflow Tools 插件已激活');

    // 注册所有命令
    registerCommands(context);

    // 注册双击选中条件编译块事件监听
    registerDoubleClickMacroSelection(context);

    // 注册活动栏侧边栏视图（上半部：符号搜索；下半部：Git 工作流）
    registerSymbolSearchView(context);
    registerWorkflowView(context);

    // 注册终端路径链接（Ctrl+点击终端路径直接打开文件，自动裁剪路径）
    registerTerminalLink(context);
}

export function deactivate() {
    // 可选清理
}
