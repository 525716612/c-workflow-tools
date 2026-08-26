import * as vscode from 'vscode';

/** 侧边栏视图中的可执行动作 */
interface WorkflowAction {
    id: string;
    label: string;
    description: string;
    command: string;
    icon: string; // codicon 名称
}

/** 视图动作列表（点击即触发对应命令） */
const ACTIONS: WorkflowAction[] = [
    {
        id: 'gitDifftoolCompare',
        label: 'Git 对比任意两节点',
        description: 'difftool 目录对比',
        command: 'c-workflow-tools.gitDifftoolCompare',
        icon: 'git-compare',
    },
    {
        id: 'packageDiff',
        label: '打包两节点差异文件',
        description: '导出 修改前/修改后 zip',
        command: 'c-workflow-tools.packageDiff',
        icon: 'package',
    },
];

/** 视图树节点：点击执行绑定的命令 */
class WorkflowItem extends vscode.TreeItem {
    constructor(action: WorkflowAction) {
        super(action.label, vscode.TreeItemCollapsibleState.None);
        this.id = action.id;
        this.description = action.description;
        this.iconPath = new vscode.ThemeIcon(action.icon);
        this.command = {
            command: action.command,
            title: action.label,
        };
    }
}

/**
 * 侧边栏视图数据提供器：展示 C Workflow 常用动作，
 * 点击节点直接触发对应命令（功能2 / 功能3）。
 */
export class WorkflowTreeProvider implements vscode.TreeDataProvider<WorkflowItem> {
    getTreeItem(element: WorkflowItem): vscode.TreeItem {
        return element;
    }

    getChildren(): vscode.ProviderResult<WorkflowItem[]> {
        return ACTIONS.map((a) => new WorkflowItem(a));
    }
}

/**
 * 注册活动栏侧边栏视图（C Workflow）。
 */
export function registerWorkflowView(context: vscode.ExtensionContext): void {
    const provider = new WorkflowTreeProvider();
    context.subscriptions.push(
        vscode.window.createTreeView('c-workflow-tools.workflowView', {
            treeDataProvider: provider,
        })
    );
}
