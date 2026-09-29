import * as vscode from 'vscode';
import { selectMacroBlock } from './features/selectMacroBlock';
import { gitDifftoolCompare } from './features/gitDifftool';
import { packageDiff } from './features/packageDiff';
import { diagnoseSymbolSearch } from './features/symbolSearchDiagnose';
import {
    showAiReviewStatus, cleanLegacyEnvironment,
    AI_REVIEW_STATUS_COMMAND, AI_REVIEW_CLEAN_LEGACY_COMMAND,
} from './features/aiReviewSetup';
import { reviewAndCommit } from './features/aiReviewCommit';
import { reviewWorkingTree, AI_REVIEW_WORKING_COMMAND } from './features/aiReviewWorking';

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
        }),

        // 功能5：AI 审查（引擎内置在插件里，只依赖 codebuddy CLI）

        // 审查并提交：提交前审暂存区，有问题先拦一下 —— 唯一能拦截的入口
        vscode.commands.registerCommand('c-workflow-tools.aiReviewCommit', () => {
            reviewAndCommit(context);
        }),

        // 审查未提交改动：工作区相对 HEAD 的改动（已暂存+未暂存），不提交，只出报告
        vscode.commands.registerCommand(AI_REVIEW_WORKING_COMMAND, () => {
            reviewWorkingTree(context);
        }),

        // 查看启动条件与本机配置（是否找到 CLI、监听哪些仓库、各范围开关）
        vscode.commands.registerCommand(AI_REVIEW_STATUS_COMMAND, () => {
            showAiReviewStatus(context);
        }),

        // 清理旧的 Python 钩子环境（它仍在生效时会与插件重复审查）
        vscode.commands.registerCommand(AI_REVIEW_CLEAN_LEGACY_COMMAND, () => {
            cleanLegacyEnvironment();
        })
    );
}
