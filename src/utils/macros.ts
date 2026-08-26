/**
 * C/C++ 条件编译宏块解析工具。
 * 独立成模块以便复用（例如未来支持其他语言的类宏结构）。
 */

/** 条件编译指令正则（不含 #define/#undef 等，本功能只针对条件编译块；容忍行首 BOM） */
const DIRECTIVE_RE = /^\uFEFF?\s*#\s*(if|ifdef|ifndef|elif|else|endif)\b/;

/**
 * 解析一行文本，返回其条件编译指令关键字（不含 #），非条件指令返回 undefined。
 */
export function extractDirective(line: string): string | undefined {
    const m = DIRECTIVE_RE.exec(line);
    if (!m) {
        return undefined;
    }
    return m[1].trim();
}

/**
 * 解析一行文本，返回条件编译指令关键字及其在行内的字符位置。
 * 位置为指令词本体（不含行首缩进与 # 符号）。
 * @returns { directive, start, end }（字符区间 [start, end)）；非条件指令返回 undefined
 */
export function extractDirectiveRange(
    line: string
): { directive: string; start: number; end: number } | undefined {
    const m = DIRECTIVE_RE.exec(line);
    if (!m) {
        return undefined;
    }
    const directive = m[1].trim();
    // 指令词位于整段匹配的末尾（正则 \b 后无其他消费），用 lastIndexOf 定位
    const start = m[0].lastIndexOf(directive);
    return { directive, start, end: start + directive.length };
}

/**
 * 判断一个指令是否为条件编译起始（#if / #ifdef / #ifndef）。
 */
export function isConditionalStart(directive: string): boolean {
    return directive === 'if' || directive === 'ifdef' || directive === 'ifndef';
}

/**
 * 从起始行（包含 #if 的一行）向下查找匹配的 #endif 行号。
 * 返回结束行号（#endif 所在行）；找不到匹配返回 -1。
 * @param lines 全部行
 * @param startIndex 起始行索引
 */
export function findMatchingEndif(lines: string[], startIndex: number): number {
    let depth = 0;
    for (let i = startIndex; i < lines.length; i++) {
        const directive = extractDirective(lines[i]);
        if (!directive) {
            continue;
        }
        if (isConditionalStart(directive)) {
            depth++;
        } else if (directive === 'endif') {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * 在给定光标行号（0-based）下，判断当前所处的条件编译块并返回可选中范围。
 * 仅在光标位于条件指令行（#if/#ifdef/#ifndef/#elif/#else/#endif）时生效。
 * @param lines 文件全部行
 * @param cursorLine 光标所在行号（0-based）
 * @returns 选中范围的行区间 [startLine, endLine]（闭区间，0-based）；不在条件块内返回 undefined
 */
export function locateMacroBlock(
    lines: string[],
    cursorLine: number
): { startLine: number; endLine: number } | undefined {
    const lineText = lines[cursorLine];
    if (!lineText) {
        return undefined;
    }
    const directive = extractDirective(lineText);
    if (!directive) {
        return undefined;
    }

    // 条件编译块：从 #if/#ifdef/#ifndef 起始，选中到匹配的 #endif
    if (isConditionalStart(directive)) {
        const end = findMatchingEndif(lines, cursorLine);
        if (end < 0) {
            return undefined;
        }
        return { startLine: cursorLine, endLine: end };
    }

    // #elif / #else / #endif：向前找最近的 #if/#ifdef/#ifndef，再向后找 #endif
    const start = findConditionalStart(lines, cursorLine);
    if (start < 0) {
        return undefined;
    }
    const end = findMatchingEndif(lines, start);
    if (end < 0) {
        return undefined;
    }
    return { startLine: start, endLine: end };
}

/**
 * 从条件块起始行（#if/#ifdef/#ifndef）向下查找同层级的第一个 #elif / #else 行。
 * 嵌套的内层条件块中的 #elif/#else 会被跳过，只匹配当前块深度的分支指令。
 * @returns #elif/#else 所在行索引；到 #endif 为止仍未找到返回 -1
 */
export function findNextElifElse(lines: string[], startIndex: number): number {
    let depth = 0;
    for (let i = startIndex + 1; i < lines.length; i++) {
        const directive = extractDirective(lines[i]);
        if (!directive) {
            continue;
        }
        if (isConditionalStart(directive)) {
            depth++;
        } else if (directive === 'endif') {
            if (depth === 0) {
                // 块已结束仍未找到 #elif/#else
                return -1;
            }
            depth--;
        } else if ((directive === 'elif' || directive === 'else') && depth === 0) {
            return i;
        }
    }
    return -1;
}

/**
 * 在条件块 [startIndex, endIndex] 内查找最后一个同层级的 #elif / #else 行。
 * 嵌套的内层条件块中的 #elif/#else 会被跳过，只匹配当前块深度的分支指令。
 * @returns 最后一个 #elif/#else 所在行索引；不存在返回 -1
 */
export function findLastElifElse(lines: string[], startIndex: number, endIndex: number): number {
    let depth = 0;
    let last = -1;
    for (let i = startIndex + 1; i <= endIndex; i++) {
        const directive = extractDirective(lines[i]);
        if (!directive) {
            continue;
        }
        if (isConditionalStart(directive)) {
            depth++;
        } else if (directive === 'endif') {
            if (depth === 0) {
                // 到达当前块末尾（#endif 所在行）
                break;
            }
            depth--;
        } else if ((directive === 'elif' || directive === 'else') && depth === 0) {
            last = i;
        }
    }
    return last;
}

/**
 * 从当前行的上一行开始向前查找包裹它的最近一个条件编译起始行（#if/#ifdef/#ifndef）。
 * 用于 #elif/#else/#endif 行定位所属条件块起点。
 * 注意必须从 cursorLine - 1 开始扫描：否则当前行若是 #endif，其自身会被计入嵌套深度，
 * 导致单层 #if/#endif 结构下无法找到配对的起始行。
 * @returns 起始行索引；找不到返回 -1
 */
export function findConditionalStart(lines: string[], cursorLine: number): number {
    let depth = 0;
    for (let i = cursorLine - 1; i >= 0; i--) {
        const directive = extractDirective(lines[i]);
        if (!directive) {
            continue;
        }
        if (directive === 'endif') {
            depth++;
        } else if (isConditionalStart(directive)) {
            if (depth === 0) {
                return i;
            }
            depth--;
        }
    }
    return -1;
}
