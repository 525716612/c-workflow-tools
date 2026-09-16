# Change Log

All notable changes to the "c-workflow-tools" extension will be documented in this file.

## [0.0.12] - 2026-09-16

### Added

- 新增：AI 代码审查（内置引擎，纯 TS/Node，不依赖 Python 与 git 钩子，后端调用本机 `codebuddy` / `cbc` CLI）
  - 提交前审查：`C Workflow: AI 审查并提交`（同时挂到源代码管理标题栏），审查暂存区，达到阻断级别先确认再提交
  - 提交后审查：监听 HEAD 变化，按 reflog 与父提交关系区分为提交/合并/变基/同步，只审真正改动的提交与人工解冲突的文件，干净合并/变基不调用 AI
  - 新增命令：`AI 审查状态`（启动条件与配置自检）、`清理旧的 AI 审查钩子环境`（一键停用旧的全局 git 钩子，避免重复审查）
  - 新增 `c-workflow-tools.aiReview.*` 配置项（开关、CLI 路径、各场景开关、阻断级别、通知方式、超时与文件/行数上限、报告语言）
  - 审查报告输出到 `<git-common-dir>/ai-review/`：`last-report.md`、`last-status.json`、`history.log`
  - 审查规则三层覆盖：内置清单 → 全局 `<globalStorage>/review-rules.md` → 仓库 `.ai-review-rules.md`
  - 独立命令行入口 `dist/cli.js`，可脱离 IDE 自测与排障
  - 启动闸门：工作区含 git 仓库且本机可用 codebuddy CLI 才启动，否则不监听、不写文件、不弹窗
- 打包差异文件：打包前对「修改前 → 修改后」方向做二次确认（第二个节点更早时把「交换」置顶为推荐项），避免目录内容左右互换

### Fixed

- 修复：打包差异文件时，节点中新增/删除的文件会让 `git archive` 直接 fatal，导致整体打包失败。现先用 `git ls-tree -r -z` 预过滤真实存在的文件，并按命令行长度预算分批提取
- 修复：Windows 下取消/超时只杀掉外层 `cmd.exe`，真正的 git/python 变成孤儿进程。新增 `killProcessTree()`（Windows 用 `taskkill /PID /T /F`），超时与取消均结束整棵进程树
- 修复：提取管道一端失败时另一端残留挂起（EPIPE/超时未清理），现两端互相关联并在失败时 kill 对方，另加超时兜底
- 修复：选择引用时 `dispose()` 触发 `onDidHide` 抢先以 `undefined` 结算，导致选择结果丢失或误判为取消
- 修复：符号搜索视图在 `retainContextWhenHidden` 下被重新 `resolveWebviewView` 时旧监听未清理，同一条消息被重复处理（重复搜索/重复打开文件），现统一在 dispose 时清理
- 修复：符号搜索诊断命令每次新建的 `CancellationTokenSource` 未释放，导致监听累积
- 修复：zip 写出失败时写流与 archiver 句柄未释放

### Changed

- 打包差异文件：进度细化为「提取 80% / 压缩 20%」并按批次上报；差异列表启用 `--find-renames`，重命名文件在「修改前」按旧路径提取
- 终端路径链接：新增文件存在性缓存（命中 30s / 未命中 2s / 上限 4000 条自动清空），避免构建日志刷屏时主线程 stat 卡顿
- 构建：esbuild 新增第二个入口 `src/aiReview/cli.ts` → `dist/cli.js`，依赖重新 bundle 进 dist

## [0.0.11] - 2026-09-04

### Fixed

- 修复：Ctrl+点击终端路径在同名文件时随机跳转，无法跳到正在编译的文件。工作区兜底搜索改为无视 `files.exclude` / `search.exclude` / `.gitignore`（`findFiles` 的 exclude 传 `null`，官方逃生口），被 settings 排除的源文件也能搜到
- 修复：带 `../` 前缀的相对路径（如 `../COMMON/OSD/DYNAMIC_ANT_GAMEING/USERDATA/UserPref.c`）无法定位。该类路径相对**构建目录**而非工作区根，现新增按 `compile_commands.json` 的 `directory` 字段解析（mtime 缓存），未启用 shell 集成时也能精确命中正在编译的文件；`../` 相对 cwd 解析也支持剥掉 `.`/`..` 段
- 改进：同名候选择优 —— 相对路径后缀匹配（`src/main.c`）优先，其次接近终端 cwd；多个同等候选时弹出选择器让用户挑选，不再随机跳转

## [0.0.10] - 2026-09-04

### Fixed

- 修复：搜索无结果时耗时过长、期间切换过滤类型不生效。原因为语言服务器 workspace 符号搜索命令不可取消、连续输入/切换类型时请求在 cpptools 端堆积，且存在全工作区正则兜底扫描导致大型工程卡顿
- 移除正则兜底全工作区扫描：语言服务器（workspace + document）无结果时直接返回空，不再逐文件读盘扫描，从根上消除兜底卡顿
- 语言服务器 workspace 搜索支持取消与超时即返回，避免请求堆积压垮 cpptools
- 切换过滤类型且关键词未变时，基于缓存的一级 workspace 结果本地过滤秒出，不再重复触发慢速搜索
- 无结果提示改为中性建议（更换关键词/切换类型），不再引导检查语言服务器

## [0.0.9] - 2026-09-02

### Added

- 新增：终端路径链接。Ctrl+点击 终端输出中的文件路径时，自动裁剪路径并直接打开文件跳转行列，不再把整行复制到文件搜索栏。支持裁剪编译器前缀/引号/行号后缀（`:行`、`:行:列`、`(行,列)`）、带空格路径（引号包裹）、相对路径（按终端 cwd 解析，需启用 shell 集成）、CMake/ninja 构建产物（`CMakeFiles/xxx.dir/*.c.o` 自动还原为源文件）。找不到文件时提示并可选回退到文件搜索（此时为裁剪后的干净路径）

### Fixed

- 修复：终端路径链接无法解析全角冒号分隔的行号格式（如 `CUSTOM/Mediatek/APP/main.c：48`），现兼容 `：行` / `：行：列` 格式

### Changed

- 符号搜索面板的类型筛选改为自定义下拉框：点击在按钮下方展开选项列表，样式跟随 VS Code 主题（避免原生 select 在 Windows 上的系统渲染白闪），支持展开动画、点击外部/Esc 收起

## [0.0.8] - 2026-09-02

### Fixed

- 修复：符号搜索在 `vscode.languages.getWorkspaceSymbolProviders` 处崩溃（该 API 并非官方 VS Code API，运行时不存在）。现改为特性检测 + 降级到 `vscode.executeWorkspaceSymbolProvider` 命令，并保留最短查询词限制与超时兜底
- 修复：符号搜索依赖语言服务器（如 cpptools）注册 workspace symbol provider，但语言服务器按需懒激活，首次搜索可能因 provider 未注册而误降级。现搜索前自动激活已安装的 C/C++ 语言服务器扩展并轮询等待 provider 就位（最长 15s，可取消），搜索面板实时显示「正在启动语言服务器…」状态

### Performance

- 启动加载提速：`archiver`（含 zip-stream/compress-commons 等依赖链）改为按需懒加载并移出主 bundle，`dist/extension.js` 约 405KB 降至 47KB（-88%）
- 双击宏块选中热路径优化：全局选择变化监听增加 C/C++ 语言过滤，非相关文件零开销；调试日志加 `DEBUG` 开关，生产构建中消除每次选词变更的日志输出

### Changed

- 补充 `onCommand` 激活事件，Git 对比/打包/符号搜索诊断命令在未打开 C/C++ 文件时也能直接使用
- `archiver` 从 devDependencies 移至 dependencies（发布时随 vsix 打包，运行时可用）

## [0.0.7] - 2026-08-31

### Fixed

- 修复：符号搜索（#）可能压垮语言服务器（如 cpptools 崩溃）。原来通过 `vscode.executeWorkspaceSymbolProvider` 命令搜索，取消令牌对其无效，连续输入时会在语言服务器端堆积无法终止的全索引搜索请求；现改为直调 `vscode.languages.getWorkspaceSymbolProviders()` 并传入可取消令牌（经 LSP `$/cancelRequest` 真正终止），同时新增最短查询词限制（过短查询跳过语言服务器搜索）与单次搜索超时兜底
- 修复：符号搜索诊断命令使用同类不可取消的搜索方式，已同步改为 provider 直调

## [0.0.6] - 2026-08-31

### Added

- 符号搜索：结果项显示符号所在文件路径（右对齐，宽度不足时省略前面保留尾部，随侧边栏宽度自适应）

### Fixed

- 修复：符号搜索结果项在侧边栏较窄时符号名被省略，现在符号名始终完整显示，仅路径可省略

## [0.0.5] - 2026-08-27

### Fixed

- 修复：快速拖选 `#endif` 等指令词到 `#` 仍会误触发双击选中整块（通过「空选区→空选区→选中单词」的双击前奏识别区分快速拖选）
- 修复：双击位置检测误拦截 `#` 不作为单词字符的选区（如双击 `#endif` 实际选中的是 `endif`），保证双击指令词选整块功能正常

## [0.0.4] - 2026-08-27

### Fixed

- 修复：按住鼠标左键缓慢拖选 `#if` 等指令词时会误触发双击选中整块（通过相邻选择事件快照识别「锚点不变、同行、选区重叠」的拖选中间态并放行）

## [0.0.3] - 2026-08-26

### Fixed

- 修复：反复双击 `#if` 等指令词时，只有第一次能选中整块（块内无 `#elif`/`#else` 时再次双击现在会重新选中整块）

### Docs

- README 完善：新增「符号搜索」功能说明、命令一览补充诊断命令、架构图补充 `views/` 目录

## [0.0.2] - 2026-08-26

### Added

- 侧边栏「符号搜索」面板：全局搜索 C/C++ 符号（函数/宏/变量/结构体/枚举），支持多词匹配、类型筛选、点击跳转定义；三级数据来源（工作区索引 → 当前文档 → 正则兜底）
- 命令 `C Workflow: 诊断符号搜索`：输出语言服务器状态与各级搜索统计，便于排查搜不到符号的问题

## [0.0.1] - 2026-08-26

### Added

- 初始版本（个人自用）
- C/C++ 宏块快捷选中（#if/#elif/#else/#endif 条件编译块、多行 #define）
- Git 任意两个节点呼出 difftool 对比
- 打包 Git 两个节点间的差异文件（修改前/修改后 两个子目录）为 zip
