# C Workflow Tools

> **个人自用**插件：针对 C/C++ 工程与 Git 工作流的定制工具集。

## 功能

> **侧边栏视图**：安装后活动栏出现「C Workflow」图标，点击展开侧边栏，包含两个面板：
> - **符号搜索**：全局搜索 C/C++ 符号（功能4）
> - **Git 工作流**：一键触发功能2 / 功能3，无需记忆快捷键

### 1. 双击选中 C/C++ 条件编译块

在 C/C++ 文件中，**双击条件编译指令词本身**（`#if` / `#elif` / `#else` / `#endif`，双击 `#` 或指令词均可）自动选中（支持嵌套匹配）。双击条件表达式中的标识符（如 `ENABLE_XXX`）不触发，保持默认选词：

- **双击 `#if` / `#ifdef` / `#ifndef` / `#elif` / `#else` / `#endif` 指令行**：
  - 第一次 → 选中整个条件编译块（`#if` → `#endif`）
  - 再次双击同一块 → 切换为**当前双击指令所在的分支块**：
    - 双击 `#if` 行 → `#if` 到第一个 `#elif` / `#else` 之前
    - 双击 `#elif` 行 → 该 `#elif` 到下一个 `#elif` / `#else` 之前
    - 双击 `#else` 行 → `#else` 到 `#endif`
    - 双击 `#endif` 行 → 最后一个 `#elif` / `#else` 到 `#endif` 之前
  - 再双击 → 切回整个块（循环切换；块内无 `#else`/`#elif` 时再次双击直接重新选中整块）

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

### 4. 全局符号搜索

侧边栏「符号搜索」面板：全局搜索工作区中的 C/C++ 符号（函数 / 宏 / 变量 / 结构体 / 枚举），点击结果即可跳转到定义处。

- **多词匹配**：输入多个关键词（以空格分隔），所有词（忽略大小写）均需出现在符号名中，如 `app turn on` 可匹配 `AppPanel_TurnOn` 等
- **类型筛选**：可切换 全部 / 函数 / 宏 / 变量 / 结构体 / 枚举
- **三级数据来源**（自动降级）：
  1. 工作区符号索引（C/C++ 语言服务器，最全）
  2. 当前文档符号
  3. 正则扫描（语言服务器不可用时兜底）
- **触发方式**：活动栏「C Workflow」→「符号搜索」，输入关键词自动搜索（回车立即搜索）；不输入关键词点击「搜索」可列出全部符号

> 说明：完整索引依赖 C/C++ 扩展（`ms-vscode.cpptools`）。搜不到符号时，可运行命令 `C Workflow: 诊断符号搜索`，输出面板会给出语言服务器状态与各级搜索统计，便于排查。

## 使用前提

- 打开的文件或工作区须位于一个 Git 仓库内。
- 需要系统已安装 Git，并在 PATH 中可调用。

## 命令一览

| 命令 ID | 标题 |
| --- | --- |
| `c-workflow-tools.selectMacroBlock` | 选中当前条件编译块（#if/#elif/#else） |
| `c-workflow-tools.gitDifftoolCompare` | Git 对比任意两个节点 |
| `c-workflow-tools.packageDiff` | 打包两节点间差异文件 |
| `c-workflow-tools.diagnoseSymbolSearch` | 诊断符号搜索（输出到输出面板） |

## 开发者

架构说明、新增功能步骤、开发构建与发布流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## License

[MIT](LICENSE)
