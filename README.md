# C Workflow Tools

> **个人自用**插件：针对 C/C++ 工程与 Git 工作流的定制工具集。
> 面向显示器/Monitor 固件开发场景，供个人日常使用，欢迎按需扩展。

## 功能

> **侧边栏视图**：安装后活动栏出现「C Workflow」图标，点击展开侧边栏，直接点条目即可触发功能2 / 功能3，无需记忆快捷键。

### 1. 双击选中 C/C++ 条件编译块

在 C/C++ 文件中，**双击条件编译指令词本身**（`#if` / `#elif` / `#else` / `#endif`，双击 `#` 或指令词均可）自动选中（支持嵌套匹配）。双击条件表达式中的标识符（如 `ENABLE_XXX`）不触发，保持默认选词：

- **双击 `#if` / `#ifdef` / `#ifndef` / `#elif` / `#else` / `#endif` 指令行**：
  - 第一次 → 选中整个条件编译块（`#if` → `#endif`）
  - 再次双击同一块 → 切换为**当前双击指令所在的分支块**：
    - 双击 `#if` 行 → `#if` 到第一个 `#elif` / `#else` 之前
    - 双击 `#elif` 行 → 该 `#elif` 到下一个 `#elif` / `#else` 之前
    - 双击 `#else` 行 → `#else` 到 `#endif`
    - 双击 `#endif` 行 → 最后一个 `#elif` / `#else` 到 `#endif` 之前
  - 再双击 → 切回整个块（循环切换；块内无 `#else`/`#elif` 时分支块即整块，不切换）

**其他触发方式**：命令面板（`Ctrl+Shift+P`）→ `C Workflow: 选中当前条件编译块`（将光标置于指令行上）。

### 2. Git 对比任意两个节点

选择任意两个 Git 节点（提交 / 分支 / 标签），调用你已配置的 **difftool**（如 Beyond Compare）进行目录对比。

**触发方式**：
- 快捷键：`Ctrl+Alt+D`（macOS：`Cmd+Alt+D`）
- 命令面板 → `C Workflow: Git 对比任意两个节点`

> 说明：对比使用 `git difftool --dir-diff`，请确保已在 Git 中配置 `diff.tool` 或 `diff.guitool`。选择节点时当前分支置顶并默认选中，第二个默认 `HEAD`，可直接回车确认，也可输入 commit hash。

### 3. 打包两个节点间的差异文件

选择两个 Git 节点，将两者之间的**差异文件**按「修改前」和「修改后」两个子目录整理并打包为 **zip**，便于发送给他人导入对策。

**触发方式**：
- 快捷键：`Ctrl+Alt+P`（macOS：`Cmd+Alt+P`）
- 命令面板 → `C Workflow: 打包两节点间差异文件`

生成后的 zip 结构示意：

```
diff_<ref1>_<ref2>.zip
└── diff_<ref1>_<ref2>/
    ├── 修改前/
    │   ├── src/foo.c        # ref1 中该文件的内容
    │   └── ...
    └── 修改后/
        ├── src/foo.c        # ref2 中该文件的内容
        └── ...
```

文件状态说明：

- 新增（A）：仅存在于「修改后」
- 删除（D）：仅存在于「修改前」
- 修改 / 重命名等：两个目录均保留

## 使用前提

- 打开的文件或工作区须位于一个 Git 仓库内。
- 需要系统已安装 Git，并在 PATH 中可调用。

## 命令一览

| 命令 ID | 标题 |
| --- | --- |
| `c-workflow-tools.selectMacroBlock` | 选中当前条件编译块（#if/#elif/#else） |
| `c-workflow-tools.gitDifftoolCompare` | Git 对比任意两个节点 |
| `c-workflow-tools.packageDiff` | 打包两节点间差异文件 |

## 架构与扩展

项目采用「每功能独立一个文件」的可扩展架构：

```
src/
├── extension.ts               # 入口：初始化输出通道、注册命令
├── registerCommands.ts        # 命令注册中心（新增功能在此登记命令）
├── outputChannel.ts           # 全局输出通道工具
├── features/
│   ├── selectMacroBlock.ts    # 功能1：C 宏块快捷选中
│   ├── gitDifftool.ts         # 功能2：Git 任意两节点 difftool 对比
│   └── packageDiff.ts         # 功能3：打包差异文件
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

## License

[MIT](LICENSE)
