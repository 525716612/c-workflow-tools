# C Workflow Tools - 开发文档

> 面向维护者。用户使用说明见 [README](README.md)。

## 架构与扩展

项目采用「每功能独立一个文件」的可扩展架构：

```
src/
├── extension.ts               # 入口：初始化输出通道、注册命令、注册侧边栏视图
├── registerCommands.ts        # 命令注册中心（新增功能在此登记命令）
├── outputChannel.ts           # 全局输出通道工具
├── features/
│   ├── selectMacroBlock.ts    # 功能1：C 宏块快捷选中
│   ├── gitDifftool.ts         # 功能2：Git 任意两节点 difftool 对比
│   ├── packageDiff.ts         # 功能3：打包差异文件
│   ├── symbolSearch.ts        # 功能4：全局符号搜索（三级来源）
│   └── symbolSearchDiagnose.ts# 符号搜索诊断命令
├── views/
│   ├── symbolSearchView.ts    # 侧边栏「符号搜索」面板（WebviewView）
│   └── workflowView.ts        # 侧边栏「Git 工作流」面板（TreeView）
└── utils/
    ├── git.ts                 # Git 命令封装
    └── macros.ts              # C 宏块解析
```

**新增功能步骤**：在 `src/features/` 新建一个文件实现功能 → 在 `registerCommands.ts` 注册对应命令 → 在 `package.json` 的 `contributes.commands` 声明命令即可。后续如需添加视图（Webview/TreeView），请遵循 VSCode 原生设计风格（使用 VSCode 主题变量、`vscode-codicons` 图标等）。

## 开发与构建

```bash
npm install        # 安装依赖
npm run compile    # 类型检查 + lint + esbuild 构建（产物在 dist/）
npm run watch      # 监听模式
npm run package    # 生产构建
npm run package:vsix   # 打包为 .vsix（上架商店用）
```

在 VSCode 中按 `F5` 可启动扩展开发调试宿主。

## 发布（VSCode Marketplace）

本插件使用 `publisher: cxy`。发布前请：

1. 更新 `package.json` 中的 `version`。
2. 使用 `npx @vscode/vsce login cxy` 登录发布账号。
3. 运行 `npx @vscode/vsce publish` 发布。
