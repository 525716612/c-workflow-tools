import * as fs from 'fs';
import * as path from 'path';

/**
 * 审查规则（三层，后者优先级更高）：
 *   1. 内置默认（DEFAULT_REVIEW_RULES）——保证「内存泄漏」这类专项检查永远生效；
 *   2. 全局自定义：<globalStorage>/review-rules.md，本机所有仓库生效；
 *   3. 仓库自定义：<repo>/.ai-review-rules.md，项目专属。
 *
 * 拼好的文本会作为「审查规则」段落插进提示词：这里写什么，模型就重点看什么。
 */

/** 仓库自定义规则文件名（沿用旧约定，已有仓库可直接生效） */
export const PROJECT_RULES_FILENAME = '.ai-review-rules.md';

/** 全局自定义规则文件名（放在插件存储目录下） */
export const GLOBAL_RULES_FILENAME = 'review-rules.md';

/** 内置默认规则清单 */
export const DEFAULT_REVIEW_RULES = `## 关注点

- 正确性优先：逻辑错误、边界条件（空集合/0/负数/最大长度）、off-by-one。
- 内存安全与资源泄漏：见下方专项清单，每次审查都必须过一遍。
- 错误处理：异常/返回值被吞掉、错误分支未回滚、失败后状态不一致。
- 并发：共享状态缺少同步、锁顺序不一致、TOCTOU、中断与主流程竞态。
- 安全：外部输入未校验、命令拼接、路径穿越、日志打印敏感信息、硬编码密钥。
- 兼容性：公共接口/序列化格式/配置文件格式的不兼容变更，需要指出影响。
- 提交内容：意外提交的调试代码、注释掉的大段代码、临时 TODO、无用的大文件。

## 内存安全与资源泄漏（专项，命中即 high）

不要只看业务逻辑，每次都要专门检查下面几类：

### 1. 泄漏

- **配对**：malloc/calloc/realloc/strdup/new 与 free/delete；自研分配接口
  （*_alloc、*_get_buffer、*_lock、池/缓存申请）与对应的释放接口是否成对。
- **所有退出路径**：提前 return、goto 错误分支、break/continue、超时与失败重试、
  longjmp。任何一条路径漏释放都算泄漏。
- **循环内分配**：每轮都申请却没释放；循环中 continue 跳过释放语句。
- **复合结构**：释放了外层结构，内部指针（链表节点、数组元素、嵌套成员）未释放。
- **重新赋值丢失**：p = malloc(...) 覆盖了仍持有旧地址的指针（原内存不可回收）。
- **句柄类同样算泄漏**：文件描述符、socket、互斥锁/信号量、定时器、任务/线程、
  硬件通道（I2C/SPI/DMA/时钟使能）、中断注册。
- **锁**：错误分支与提前返回路径上是否解锁。

### 2. 越界与内存破坏

- memcpy/memmove/memset/strcpy/strncpy/sprintf/snprintf 的长度与目标剩余空间校验；
  长度是否来自外部输入、寄存器、协议头部等未校验来源。
- 数组下标与循环边界；sizeof 误用（元素数当字节数、对指针取 sizeof）。
- 字符串未保证结束符；strncpy 不补 \\0 后当字符串使用。
- 拷贝后对齐/填充区域（padding）是否需要处理。

### 3. 悬垂与重复释放

- free 后继续使用；free 后未置 NULL 而被再次释放（双重释放）。
- 返回指向局部变量或已释放内存的指针（含把内部缓冲指针交给调用方）。
- 保存了指向容器元素的指针，容器扩容/删除后继续使用。

### 4. 未初始化与栈

- 结构体/数组成员未初始化即使用，或整体 memcpy/发送出去（信息泄漏）。
- 大局部数组、深递归、变长数组 —— 栈溢出（嵌入式栈常只有几 KB）。
- 大结构体按值传参/返回带来的栈占用与拷贝开销。

### 5. 整型与长度计算

- 长度/大小计算溢出（count * size 无上限校验）；有符号与无符号混用导致负数变巨大。
- int / size_t / uint16 截断造成"校验通过但实际越界"。

### 6. 并发与中断

- 共享缓冲/引用计数缺少临界区保护，一边释放一边使用。
- 中断上下文中释放内存或调用不可重入的分配/释放接口。
- 释放后未通知其他持有者（事件/队列/信号量仍留引用）。

## 报告要求

- 命中上述任一类时标注**类别**（泄漏 / 越界 / 悬垂 / 未初始化 / 整数溢出 / 并发），
  并写清"哪条路径、哪个变量、哪个调用点"导致；禁止只写"可能有内存泄漏"这类泛泛结论。
- 内存安全类（泄漏、越界、悬垂、重复释放）严重级别不低于 high。
- 若某类确实检查过但没有问题，不必逐项声明，只报告发现的问题。

## 不要报告

- 把删除/替换旧实现直接判为"功能回归"。diff 只是片段，看不到全仓库：旧逻辑可能已由
  diff 之外的新实现替代（如 __weak 默认实现被强符号重写覆盖、调用点已切换到新架构）。
  此类情况应在 detail 中标注"需确认"替代实现是否完整，而不是直接报告删除有问题；
  只有能指出确切破坏点（调用点的函数已无任何实现且无替代迹象）才报告。
- 与本次改动无关的历史代码问题。
- 纯格式偏好（空格、大括号位置），除非严重影响可读性。
- 缺少单元测试、缺少文档之类的泛泛建议。
- 与项目实际技术栈无关的通用最佳实践。

## 输出风格

- 中文描述，代码标识符保持原文。
- 每条问题给出具体修改建议，而不是"建议优化"。
- 没有把握时标注"需确认"，不要编造上下文。`;

export interface RuleSet {
    /** 内置默认 + 全局自定义 */
    general: string;
    /** 仓库自定义（优先级最高） */
    project: string;
    /** 全局规则文件路径（可能不存在） */
    globalFile: string;
    /** 仓库规则文件路径（可能不存在） */
    projectFile: string;
}

/** 读取规则文件，不存在或不可读时返回空串 */
function readRuleFile(file: string): string {
    try {
        return fs.readFileSync(file, 'utf8').trim();
    } catch {
        return '';
    }
}

/**
 * 加载三层规则。
 * @param repoRoot 仓库根目录
 * @param globalRulesFile 全局自定义规则文件（通常 <globalStorage>/review-rules.md）
 */
export function loadRules(repoRoot: string, globalRulesFile?: string): RuleSet {
    const globalFile = globalRulesFile ?? '';
    const projectFile = path.join(repoRoot, PROJECT_RULES_FILENAME);
    const globalText = globalFile ? readRuleFile(globalFile) : '';
    const general = globalText
        ? `${DEFAULT_REVIEW_RULES}\n\n# 全局自定义规则（优先级高于内置默认）\n\n${globalText}`
        : DEFAULT_REVIEW_RULES;
    return {
        general,
        project: readRuleFile(projectFile),
        globalFile,
        projectFile,
    };
}

/**
 * 首次使用时把内置清单写成可编辑文件，方便直接改。
 * 已存在则不动（避免覆盖用户修改）。
 */
export function ensureRulesFile(file: string): void {
    try {
        if (fs.existsSync(file)) {
            return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `# 全局审查规则（本机所有仓库生效，优先级高于内置默认）\n\n`
            + DEFAULT_REVIEW_RULES + '\n', 'utf8');
    } catch {
        // 写不了就算了，内置清单仍然生效
    }
}
