import * as vscode from 'vscode';
import {
    extractDirectiveRange,
    findLastElifElse,
    findNextElifElse,
    locateMacroBlock,
} from '../utils/macros';
import { log, logError } from '../outputChannel';

/** 双击切换状态有效时间窗（毫秒）：同一块在窗口内再次双击才切换分支/整块 */
const STATE_TIMEOUT_MS = 3000;

/** 判定相邻选区事件属于同一拖选过程的时间上限（毫秒）：缓慢拖选中途的停顿间隔 */
const DRAG_EVENT_WINDOW_MS = 2000;

/** 判定双击选词两次点击的间隔上限（毫秒）：与系统双击速度一致 */
const DOUBLE_CLICK_MS = 500;

/** 双击两次点击允许的位置偏差（字符）：双击连点位置基本相同 */
const DOUBLE_CLICK_POS_TOLERANCE = 5;

/** 条件编译块选中模式：whole=整块（#if→#endif），branch=分支块（某个分支指令到下一个分支指令之前） */
type SelectMode = 'whole' | 'branch';

/** 上次双击的块状态（用于再次双击切换选中范围） */
interface DoubleClickState {
    startLine: number;
    endLine: number;
    mode: SelectMode;
    updateTime: number;
}

/** 最近一次选择变化事件的快照（用于区分双击选词与拖选） */
interface SelectionChangeSnapshot {
    editor: vscode.TextEditor;
    selection: vscode.Selection;
    /** 选择变化来源：鼠标/键盘/命令（命令触发可能为 undefined） */
    kind: vscode.TextEditorSelectionChangeKind | undefined;
    time: number;
}

/**
 * 判断相邻两次选择事件是否属于同一拖选过程（如按住左键缓慢选中 #if）。
 *
 * 拖选的特征：锚点（鼠标按下位置）保持不变、选区在同一行内连续扩展、
 * 且与上一次选区重叠（锚点一侧始终包含在选区内）；
 * 而双击选词是"空选区 → 完整单词"的一次性跳变，不满足这些条件。
 * 双击切换分支时上一次是本扩展设置的跨行整块选区，也会被同行条件排除。
 */
function isDragContinuation(prev: SelectionChangeSnapshot, editor: vscode.TextEditor, cur: vscode.Selection, intervalMs: number): boolean {
    if (intervalMs > DRAG_EVENT_WINDOW_MS || prev.editor !== editor || prev.selection.isEmpty) {
        return false;
    }
    const p = prev.selection;
    // 拖选锚点固定（鼠标按下位置不变）；双击产生的新选区锚点是单词端点，与上次不同
    if (!p.anchor.isEqual(cur.anchor)) {
        return false;
    }
    // 拖选在同一行内进行；跨行选区（如整块）不属于拖选中间态
    if (p.start.line !== cur.start.line || p.end.line !== cur.end.line) {
        return false;
    }
    const pStart = Math.min(p.start.character, p.end.character);
    const pEnd = Math.max(p.start.character, p.end.character);
    const cStart = Math.min(cur.start.character, cur.end.character);
    const cEnd = Math.max(cur.start.character, cur.end.character);
    // 两次选区有重叠 → 同一拖选过程的中间态
    return pEnd >= cStart && cEnd >= pStart;
}

/**
 * 判断上一条、上上条事件是否构成"双击选词的前奏"（两次位置接近的空选区鼠标点击）。
 *
 * 双击选词的完整事件序列为：第一次点击（空选区）→ 第二次按下（空选区）→ 抬起选中单词；
 * 而快速拖选（拖速快、中间态事件被 VS Code 合并）只有"按下（空选区）→ 直接扩展到完整选区"，
 * 缺少第二次空选区点击。据此区分二者，避免快速拖选误触发双击选中整块。
 */
function isDoubleClickWordSequence(prev: SelectionChangeSnapshot, prevPrev: SelectionChangeSnapshot | undefined, now: number): boolean {
    // 上一条必须是"鼠标按下的空选区"（双击的第二次按下；拖选的按下也符合，继续往下区分）
    if (prev.kind !== vscode.TextEditorSelectionChangeKind.Mouse || !prev.selection.isEmpty) {
        return false;
    }
    // 上上条必须是"鼠标点击的空选区"（双击的第一次点击）
    if (!prevPrev || prevPrev.kind !== vscode.TextEditorSelectionChangeKind.Mouse || !prevPrev.selection.isEmpty) {
        return false;
    }
    // 两次点击间隔必须在系统双击速度内
    if (now - prev.time > DOUBLE_CLICK_MS || now - prevPrev.time > DOUBLE_CLICK_MS) {
        return false;
    }
    // 双击连点位置基本相同（几乎不动鼠标）；拖选前的单击点通常与按下点不同
    const a = prev.selection.active;
    const b = prevPrev.selection.active;
    return a.line === b.line && Math.abs(a.character - b.character) <= DOUBLE_CLICK_POS_TOLERANCE;
}

/**
 * 将编辑器选中范围设置为指定行区间（不移动视图）。
 */
function selectRange(editor: vscode.TextEditor, lines: string[], startLine: number, endLine: number): void {
    const start = new vscode.Position(startLine, 0);
    const end = new vscode.Position(endLine, lines[endLine].length);
    const target = new vscode.Selection(start, end);
    // 已选中相同范围则跳过，避免重复触发事件
    if (!editor.selection.isEqual(target)) {
        editor.selection = target;
    }
}

/**
 * 将编辑器选中范围设置为光标所在的条件编译块（从 #if 到匹配的 #endif）。
 * 仅修改选中范围，不移动视图（不调用 revealRange）。
 * @param editor 目标编辑器
 * @param lines 文档全部行
 * @param cursorLine 光标所在行号（0-based）
 * @returns 命中并选中返回块信息；未命中返回 undefined
 */
export function applyMacroBlockSelection(
    editor: vscode.TextEditor,
    lines: string[],
    cursorLine: number
): { startLine: number; endLine: number } | undefined {
    const block = locateMacroBlock(lines, cursorLine);
    if (!block) {
        return undefined;
    }
    selectRange(editor, lines, block.startLine, block.endLine);
    return block;
}

/**
 * 计算条件块内指定指令行（#if/#elif/#else/#endif）所在分支的范围（闭区间，0-based）。
 * - 双击 #if 行：分支为 #if 到第一个 #elif/#else 之前
 * - 双击 #elif 行：分支为该 #elif 到下一个 #elif/#else 之前
 * - 双击 #else 行：分支为 #else 到 #endif
 * - 双击 #endif 行：分支为最后一个 #elif/#else 到 #endif 之前
 * @returns 分支行区间；若分支与整块相同（块内无 #elif/#else 结构）返回 undefined
 */
function getBranchRange(
    lines: string[],
    whole: { startLine: number; endLine: number },
    directiveLine: number
): { startLine: number; endLine: number } | undefined {
    // #endif 行：分支为最后一个同层分支指令到 #endif 之前
    if (directiveLine === whole.endLine) {
        const last = findLastElifElse(lines, whole.startLine, whole.endLine);
        if (last === -1) {
            return undefined;
        }
        return { startLine: last, endLine: whole.endLine - 1 };
    }
    const next = findNextElifElse(lines, directiveLine);
    const end = next === -1 ? whole.endLine : next - 1;
    // 块内无 #elif/#else 时分支即整块，无可切换
    if (directiveLine === whole.startLine && end === whole.endLine) {
        return undefined;
    }
    return { startLine: directiveLine, endLine: end };
}

/**
 * 功能1：C/C++ 条件编译块快捷选中（命令触发）。
 * 当光标位于 #if/#ifdef/#ifndef/#elif/#else/#endif 条件编译指令行上时，
 * 一键选中整个条件编译块（从 #if 到匹配的 #endif）。
 */
export async function selectMacroBlock(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        logError('没有活动的编辑器。');
        return;
    }

    const cursorLine = editor.selection.active.line;
    const lines = editor.document.getText().split(/\r?\n/);

    const block = applyMacroBlockSelection(editor, lines, cursorLine);
    if (!block) {
        const msg = '光标不在条件编译指令行上（#if/#elif/#else/#endif 等）。';
        log(msg);
        vscode.window.showInformationMessage(msg);
        return;
    }
    // 命令触发时滚动视图居中显示选中的块（双击触发不移动视图）
    editor.revealRange(
        new vscode.Range(block.startLine, 0, block.endLine, lines[block.endLine].length),
        vscode.TextEditorRevealType.InCenter
    );
    log(`已选中条件编译块（行 ${block.startLine + 1} - ${block.endLine + 1}）`);
}

/**
 * 功能1（双击触发）：在 C/C++ 编辑器中双击条件编译指令词自动选中。
 *
 * - 双击 `#if/#ifdef/#ifndef/#elif/#else/#endif` 指令词：
 *   第一次选中整个条件编译块（#if→#endif）；
 *   在 3 秒内再次双击同一块则切换为「当前双击指令所在的分支块」：
 *     - 双击 #if 行 → 分支为 #if 到第一个 #elif/#else 之前
 *     - 双击 #elif 行 → 分支为该 #elif 到下一个 #elif/#else 之前
 *     - 双击 #else 行 → 分支为 #else 到 #endif
 *     - 双击 #endif 行 → 分支为最后一个 #elif/#else 到 #endif 之前
 *   再双击切回整块（循环切换）。
 * - 双击条件表达式中的标识符（如 ENABLE_XXX）不触发，保持默认选词。
 *
 * 实现原理：VS Code 无原生双击事件，通过选择变化事件识别"双击选词"——
 * 双击选中单词必然产生非空、单行、且与语言单词范围匹配的选区。
 * 该判定不依赖"前序单击事件的时间间隔"，因此光标原本就停在指令词上时
 * （首次单击不产生选择变化事件）也能可靠触发。
 */
export function registerDoubleClickMacroSelection(context: vscode.ExtensionContext): void {
    let lastState: DoubleClickState | undefined;
    let lastChange: SelectionChangeSnapshot | undefined;
    /** 上上条选择事件快照（用于识别双击选词的"空选区→空选区"前奏） */
    let prevPrevChange: SelectionChangeSnapshot | undefined;
    /** 拖选中间态提示：本行最近出现过"仅选中指令词本体（不含 #）"的选区，可能是拖选过程的中间状态 */
    let dragHint: { line: number; time: number } | undefined;

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            const editor = e.textEditor;
            const selection = e.selections[0];
            if (!selection) {
                return;
            }
            const now = Date.now();
            // 记录本次选择变化快照，供下一次事件判断是否为同一拖选过程的中间态
            const prevChange = lastChange;
            prevPrevChange = prevChange;
            lastChange = { editor, selection, kind: e.kind, time: now };
            // 单击（空选区）：仅移动光标，不处理。
            // 但如果光标不在条件指令词上（例如点击其他位置取消选中），
            // 清除上次双击状态，使后续双击重新视为"首次"（重新选中整块）。
            // 注意：双击自身的第一次点击（光标落在指令词上）会保留状态，
            // 保证"整块→分支→整块"的原地切换仍能正常触发。
            if (selection.isEmpty) {
                // 鼠标按下/单击产生新光标：上一轮拖选已结束，清空拖选中间态提示
                dragHint = undefined;
                const clickLine = editor.document.lineAt(selection.active.line).text;
                const d = extractDirectiveRange(clickLine);
                const ch = selection.active.character;
                if (!d || ch <= 0 || ch >= d.end) {
                    lastState = undefined;
                }
                return;
            }
            // 忽略跨行选区（双击选词一定在单行内；拖选跨行不处理）
            if (selection.start.line !== selection.end.line) {
                return;
            }

            const activeLine = selection.active.line;
            const lineText = editor.document.lineAt(activeLine).text;
            // 调试日志：双击候选命中指令行的诊断信息
            log(`[双击诊断] lang=${editor.document.languageId} line=${activeLine + 1} text=${JSON.stringify(lineText)} sel=[${selection.start.line + 1}:${selection.start.character},${selection.end.line + 1}:${selection.end.character}]`);
            // 该行必须是指令行（#if/#elif/#else/#endif）
            const directive = extractDirectiveRange(lineText);
            if (!directive) {
                log(`[双击拦截] 非指令行`);
                lastState = undefined;
                return;
            }
            // 三击（整行选区）识别：不与 VS Code 默认三击选行冲突
            // 三击的事件序列为 单击→双击(词)→三击(整行)，若不处理，
            // 第二次"选词"事件会先触发整块选中、第三次"整行"事件又会误切换分支。
            if (selection.start.character === 0 && selection.end.character >= lineText.length) {
                const lines = editor.document.getText().split(/\r?\n/);
                const w = locateMacroBlock(lines, activeLine);
                // 若是紧跟双击后的三击（3 秒内、同一块），保持整块选中，不切换到分支
                if (lastState && w && lastState.startLine === w.startLine && now - lastState.updateTime < STATE_TIMEOUT_MS) {
                    selectRange(editor, lines, w.startLine, w.endLine);
                    lastState = {
                        startLine: w.startLine,
                        endLine: w.endLine,
                        mode: 'whole',
                        updateTime: now,
                    };
                    log(`[三击] 保持整块（行 ${w.startLine + 1} - ${w.endLine + 1}）`);
                    return;
                }
                // 首次三击：让 VS Code 默认三击选行生效
                lastState = undefined;
                log(`[三击] 放行默认选行`);
                return;
            }
            // 双击位置允许两类选区：
            // 1) 覆盖 # 指令符号（如 #endif 整体 [0,5)）
            // 2) 恰为完整指令词本体（如双击选中的 endif [1,5)——C/C++ 语言配置中
            //    # 不属于单词字符，双击 #endif 选中的是 endif，不含 #）
            // 其余（部分词选区、仅选中 # 等）按"普通选词"拦截，不触发块选中；
            // 双击条件表达式中的标识符（如 ENABLE_EXT_DEVICE_LG_OLED）同理不触发。
            const selStart = selection.start.character;
            const selEnd = selection.end.character;
            const hashPos = lineText.indexOf('#');
            const coverHash = selEnd > hashPos && selStart <= hashPos;
            const fullDirectiveWord = selStart >= directive.start && selEnd <= directive.end;
            if (!coverHash && !fullDirectiveWord) {
                log(`[双击拦截] 普通选词（未覆盖 # 且非完整指令词）`);
                lastState = undefined;
                // 选区落在指令词范围内但非完整词（如从 #endif 的 f 往回拖选的部分中间态）：
                // 记录提示供后续选区兜底放行
                if (selStart >= directive.start && selEnd <= directive.end) {
                    dragHint = { line: activeLine, time: now };
                }
                return;
            }
            // 单词选区校验（双击选词特征，尽力排除拖选）：
            // 双击选中的是语言单词（或覆盖单词的 #if 选区）；拖选任意范围大概率不匹配。
            const wordRange = editor.document.getWordRangeAtPosition(selection.active);
            if (wordRange) {
                const isWordSelection =
                    selStart <= wordRange.start.character &&
                    selEnd >= wordRange.end.character;
                if (!isWordSelection) {
                    log(`[双击拦截] 非单词选区`);
                    lastState = undefined;
                    return;
                }
            }
            // 光标不在单词上（如双击分隔符 # 时的边缘情况）：不拦截，交由指令词位置判定兜底

            // 快速拖选检测：拖速快时 VS Code 会合并/跳过中间态事件，事件序列退化为
            // "按下（空选区）→ 直接扩展到完整选区"，与双击（空选区→空选区→选中单词）
            // 相比缺少第二次空选区点击（isDoubleClickWordSequence 判定失败即拦截）。
            if (
                prevChange &&
                prevChange.kind === vscode.TextEditorSelectionChangeKind.Mouse &&
                prevChange.selection.isEmpty &&
                now - prevChange.time < DRAG_EVENT_WINDOW_MS &&
                !isDoubleClickWordSequence(prevChange, prevPrevChange, now)
            ) {
                log(`[双击拦截] 快速拖选（按下后直接扩展选区）`);
                lastState = undefined;
                dragHint = undefined;
                return;
            }
            // 缓慢拖选检测：按住左键缓慢选中 #if 等指令词时，选区会先经历"部分单词"
            // 中间态再扩展为完整单词；双击选词则是空选区直接跳变为完整单词选区。
            // 据此区分，避免缓慢拖选误触发双击选中整块。
            if (prevChange && isDragContinuation(prevChange, editor, selection, now - prevChange.time)) {
                log(`[双击拦截] 拖选过程（锚点不变、选区重叠）`);
                lastState = undefined;
                dragHint = undefined;
                return;
            }
            // 兜底：本行短时间内选中过"指令词本体"（如 endif，不含 #）选区——
            // 这是从指令词内部往回拖选的中间态特征（如缓慢从 #endif 的 f 拖到 #）。
            // 此时即使本次选区恰好等于完整单词、无法凭选区本身与双击区分，也放行。
            if (dragHint) {
                if (dragHint.line === activeLine && now - dragHint.time < DRAG_EVENT_WINDOW_MS) {
                    log(`[双击拦截] 拖选扩展（指令词中间态提示）`);
                    lastState = undefined;
                    dragHint = undefined;
                    return;
                }
                // 提示过期或属于其他行，不再有用
                dragHint = undefined;
            }

            const lines = editor.document.getText().split(/\r?\n/);
            const whole = locateMacroBlock(lines, activeLine);
            if (!whole) {
                log(`[双击拦截] 未找到所属条件编译块`);
                lastState = undefined;
                return;
            }
            const branch = getBranchRange(lines, whole, activeLine);

            // 3 秒内再次双击同一块：整块 → 切换为当前双击行所在的分支
            if (
                lastState &&
                lastState.mode === 'whole' &&
                lastState.startLine === whole.startLine &&
                lastState.endLine === whole.endLine &&
                now - lastState.updateTime < STATE_TIMEOUT_MS
            ) {
                if (branch) {
                    selectRange(editor, lines, branch.startLine, branch.endLine);
                    lastState = {
                        startLine: whole.startLine,
                        endLine: whole.endLine,
                        mode: 'branch',
                        updateTime: now,
                    };
                    log(`双击切换为分支块（行 ${branch.startLine + 1} - ${branch.endLine + 1}）`);
                    return;
                }
                // 块内无 #elif/#else 结构，分支即整块，无可切换。
                // 直接重新选中整块：否则选区停留在 #if 单词上，
                // 反复双击将只有第一次能选中区块。
                selectRange(editor, lines, whole.startLine, whole.endLine);
                lastState = {
                    startLine: whole.startLine,
                    endLine: whole.endLine,
                    mode: 'whole',
                    updateTime: now,
                };
                log(`[双击] 无 #elif/#else 分支，重新选中整块（行 ${whole.startLine + 1} - ${whole.endLine + 1}）`);
                return;
            }

            // 3 秒内再次双击同一块：分支 → 切回整块
            if (
                lastState &&
                lastState.mode === 'branch' &&
                lastState.startLine === whole.startLine &&
                now - lastState.updateTime < STATE_TIMEOUT_MS
            ) {
                selectRange(editor, lines, whole.startLine, whole.endLine);
                lastState = {
                    startLine: whole.startLine,
                    endLine: whole.endLine,
                    mode: 'whole',
                    updateTime: now,
                };
                log(`双击切换回整块（行 ${whole.startLine + 1} - ${whole.endLine + 1}）`);
                return;
            }

            // 首次双击（或离开该块超过 3 秒后再次双击）：选中整块
            selectRange(editor, lines, whole.startLine, whole.endLine);
            lastState = {
                startLine: whole.startLine,
                endLine: whole.endLine,
                mode: 'whole',
                updateTime: now,
            };
            log(`双击选中条件编译块（行 ${whole.startLine + 1} - ${whole.endLine + 1}）`);
        })
    );
}
