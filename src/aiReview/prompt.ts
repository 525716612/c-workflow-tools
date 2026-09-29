import type { DiffEntry, ReviewScope } from './types';
import type { RuleSet } from './rules';

/**
 * 提示词构建。与旧 Python 版保持一致（同样的要求、同样的 JSON 结构、同样的分段），
 * 以便审查质量不因移植而下降。
 */

// 「删除/替换旧实现不要直接判为功能回归」的引导统一放在审查规则段（rules.ts 的
// DEFAULT_REVIEW_RULES，会经 buildPrompt 拼进提示词），此模板不重复，避免同一约束两份措辞。
const PROMPT_ZH = `你是一名资深代码审查工程师，正在对一次 git 改动做审查。

【审查要求】
1. 只审查下面 diff 中新增/修改的代码，不要评论未改动的历史代码，不要泛泛而谈。
2. 只在能指出具体问题时才报告；如果确实没问题，findings 返回空数组。
3. 严重程度定义：
   - high：崩溃、数组越界、空指针、缓冲区溢出、内存破坏、竞态/死锁、功能回归；
   - medium：逻辑缺陷、返回值未检查、错误分支未处理、整数截断/符号问题、可移植性、资源泄漏；
   - low：可读性、命名、注释与实现不符、魔法数字、重复代码。
4. 每条问题必须给出：文件路径、行号（以 diff 中新增行的行号为准，可以是范围）、问题描述、具体修改建议。
5. 如果因为 diff 被截断而缺少上下文，无法确认时请在 detail 中说明"需确认"，不要凭空推断。
6. 针对本项目的实际技术栈和约定审查，忽略与项目技术栈无关的通用建议。
7. 输出必须是单个 JSON 对象，不要输出 JSON 以外的任何内容（不要 markdown 代码块）。

【输出 JSON 结构】
{"summary":"一句话总体评价","risk":"high|medium|low","findings":[{"severity":"high|medium|low","file":"路径","line":"行号或范围","title":"问题标题","detail":"问题说明与影响","suggestion":"具体修改建议"}]}
`;

// 同 PROMPT_ZH：「删除/重构不误报」的引导只保留在 rules 段，模板正文不放维护者说明
const PROMPT_EN = `You are a senior code reviewer. Review the git changes below.

Rules:
1. Only review added/modified lines in the diff; do not comment on untouched code.
2. Report a finding only when you can point at a concrete problem, otherwise return an empty findings array.
3. Severity: high = crash, out-of-bounds, null deref, buffer overflow, memory corruption,
   race/deadlock, functional regression;
   medium = logic defect, unchecked return value, unhandled error path, integer truncation/sign issue,
   portability, resource leak;
   low = readability, naming, stale comment, magic number, duplication.
4. Each finding must include file path, line number(s) in the new file, description and a concrete fix.
5. If the diff was truncated and context is missing, say "needs verification" instead of guessing.
6. Review against this project's actual stack and conventions, skip generic advice.
7. Output a single JSON object and nothing else (no markdown fence).

JSON schema:
{"summary":"one line verdict","risk":"high|medium|low","findings":[{"severity":"high|medium|low","file":"path","line":"line or range","title":"title","detail":"why it matters","suggestion":"concrete fix"}]}
`;

/** 各审查范围在提示词里的中文说明（事后审查时讲清"这是什么改动"） */
const SCOPE_CONTEXT: Record<ReviewScope, string> = {
    staged: '本次是提交前审查：下面是即将提交的暂存区改动。',
    working: '本次是提交前审查：下面是工作区中尚未提交的改动（相对 HEAD，含已暂存与未暂存）。',
    commit: '本次是提交后审查：下面是这次提交引入的改动。',
    merge: '本次是合并提交审查：下面只包含人工解冲突时手写的内容'
        + '（git 记录的与两个父提交都不同的文件），其余合并内容来自被合并分支、无需重复审查。',
    rebase: '本次是变基后审查：下面只包含变基过程中被人工改写的提交'
        + '（与原始提交逐行比对后内容有变化的），其余重放的提交已审过。',
    sync: '本次是同步审查：下面是本次合并/拉取带入本分支的提交（本分支上首次出现的代码）。',
};

export interface PromptInput {
    entries: DiffEntry[];
    scope: ReviewScope;
    rules: RuleSet;
    language: string;
    /** 额外的范围说明（可选，覆盖默认文案） */
    context?: string;
    notes?: string[];
}

/** 构建提示词 */
export function buildPrompt(input: PromptInput): string {
    const { entries, scope, rules, language } = input;
    const zh = language.startsWith('zh');
    const totalAdd = entries.reduce((sum, e) => sum + e.added, 0);
    const totalDel = entries.reduce((sum, e) => sum + e.deleted, 0);

    const parts: string[] = [zh ? PROMPT_ZH : PROMPT_EN, '\n'];
    const context = input.context ?? SCOPE_CONTEXT[scope];
    parts.push((zh ? '【本次审查范围】\n' : '[Scope of this review]\n') + context + '\n\n');

    if (rules.general) {
        parts.push((zh ? '【通用审查规则】\n' : '[General review rules]\n') + rules.general + '\n\n');
    }
    if (rules.project) {
        parts.push((zh
            ? '【项目专属审查规则（优先级高于通用规则）】\n'
            : '[Project specific rules, take precedence over the general ones]\n') + rules.project + '\n\n');
    }
    if (input.notes && input.notes.length > 0) {
        parts.push((zh ? '【本次收集说明】\n' : '[Collection notes]\n')
            + input.notes.map((n) => `- ${n}`).join('\n') + '\n\n');
    }
    parts.push(zh
        ? `【本次改动概览】共 ${entries.length} 个文件，+${totalAdd} -${totalDel} 行\n\n`
        : `[Change summary] ${entries.length} files, +${totalAdd} -${totalDel}\n\n`);
    parts.push(zh ? '【待审查 diff】\n' : '[Diff to review]\n');

    for (const entry of entries) {
        const label = entry.commit ? `  [${entry.commit}]` : '';
        const truncated = entry.truncated ? (zh ? ' [diff 已截断]' : ' [diff truncated]') : '';
        parts.push(`### FILE: ${entry.path}${label} (+${entry.added} -${entry.deleted})${truncated}\n`);
        parts.push(entry.patch + '\n\n');
    }
    return parts.join('');
}
