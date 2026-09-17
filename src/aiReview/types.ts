/**
 * AI 审查引擎的类型定义（不依赖 vscode，可独立运行）。
 */

/** 严重级别 */
export type Severity = 'high' | 'medium' | 'low';

/** 严重级别权重（排序用） */
export const SEVERITY_ORDER: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** 单条问题 */
export interface Finding {
    severity: Severity;
    file: string;
    line: string;
    title: string;
    detail: string;
    suggestion: string;
}

/** 模型返回并规范化后的结果 */
export interface ReviewResult {
    summary: string;
    /** high | medium | low（模型给出的整体风险，可能为空） */
    risk: string;
    findings: Finding[];
}

/** 一个待审查文件块 */
export interface DiffEntry {
    path: string;
    /** 该文件的 patch（已按上限截断） */
    patch: string;
    added: number;
    deleted: number;
    /** patch 是否被截断 */
    truncated: boolean;
    /** 变基/同步场景下标注来源提交 */
    commit?: string;
}

/** 审查范围 */
export type ReviewScope = 'staged' | 'commit' | 'merge' | 'rebase' | 'sync';

/** 一次审查的输入 */
export interface CollectResult {
    entries: DiffEntry[];
    /** 被跳过的文件（非源码/二进制等） */
    skipped: string[];
    /** 提示信息（截断、上限等） */
    notes: string[];
    added: number;
    deleted: number;
    /** 本次实际送审的提交 sha（用于记录"审过"，下次不再重复审） */
    commits?: string[];
}

/** 引擎配置（由 VS Code 设置或命令行参数提供） */
export interface ReviewConfig {
    /** codebuddy CLI 路径（空 = 自动探测） */
    cliPath: string;
    /** 传给 CLI 的额外参数（默认 --disallowedTools <deny>） */
    cliArgs: string[];
    /** 单次调用超时（秒） */
    timeoutSec: number;
    maxFiles: number;
    maxDiffKb: number;
    maxFileLines: number;
    /** 改动行数低于该值跳过（0 = 不跳过） */
    minLines: number;
    language: 'zh' | 'en';
    /** block 只会影响"审查并提交"命令；事后审查只能报告 */
    blockAt: Severity;
    /** 全局自定义规则文件（<globalStorage>/review-rules.md） */
    globalRulesFile?: string;
    /** 单次带入本分支的提交数量上限（同步/变基/合并场景） */
    maxCommits: number;
    /** 是否审查 AI 返回结果的原始文本（调试用，写入报告） */
    keepRaw: boolean;
}

/** 默认配置 */
export function defaultConfig(): ReviewConfig {
    return {
        cliPath: '',
        cliArgs: ['--disallowedTools', 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch'],
        timeoutSec: 300,
        maxFiles: 10,
        maxDiffKb: 80,
        maxFileLines: 400,
        minLines: 0,
        language: 'zh',
        blockAt: 'high',
        maxCommits: 10,
        keepRaw: false,
    };
}

/** 审查结论状态 */
export type ReviewStatus = 'reviewed' | 'clean' | 'timeout' | 'error' | 'skipped';

/** 写入 last-status.json 的记录（也是 IDE 弹窗的数据来源） */
export interface ReviewStatusRecord {
    time: string;
    status: ReviewStatus;
    status_text: string;
    detail: string;
    head: string;
    repo: string;
    scope: ReviewScope;
    files: number;
    added: number;
    deleted: number;
    backend: string;
    elapsed: number;
    risk: string;
    counts: Record<string, number>;
    degraded: string;
    summary: string;
}

/** 状态对应的中文说明 */
export const STATUS_TEXT: Record<ReviewStatus, string> = {
    reviewed: '已审查，发现问题（见报告）',
    clean: '已审查，未发现问题',
    timeout: '未审查：AI 调用超时',
    error: '未审查：AI 调用失败',
    skipped: '未审查：本次无需审查或已跳过',
};

/** 一次审查的产物 */
export interface ReviewOutcome {
    status: ReviewStatus;
    record: ReviewStatusRecord;
    result?: ReviewResult;
    /** 渲染后的报告 Markdown */
    report: string;
    /** 给终端的纯文本报告 */
    text: string;
    /** 报告文件路径（未写成功时为空） */
    reportPath: string;
    /** 达到 blockAt 级别的问题数量（用于"审查并提交"决定是否拦截） */
    blockingCount: number;
    /** 展示用的一句话结论 */
    message: string;
}
