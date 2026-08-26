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

/** 条件编译块选中模式：whole=整块（#if→#endif），branch=分支块（某个分支指令到下一个分支指令之前） */
type SelectMode = 'whole' | 'branch';

/** 上次双击的块状态（用于再次双击切换选中范围） */
interface DoubleClickState {
    startLine: number;
    endLine: number;
    mode: SelectMode;
    updateTime: number;
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

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((e) => {
            const editor = e.textEditor;
            const selection = e.selections[0];
            if (!selection) {
                return;
            }
            // 单击（空选区）：仅移动光标，不处理。
            // 但如果光标不在条件指令词上（例如点击其他位置取消选中），
            // 清除上次双击状态，使后续双击重新视为"首次"（重新选中整块）。
            // 注意：双击自身的第一次点击（光标落在指令词上）会保留状态，
            // 保证"整块→分支→整块"的原地切换仍能正常触发。
            if (selection.isEmpty) {
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
                const now = Date.now();
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
            // 双击位置必须落在指令词上（含 # 符号）：
            // 双击条件表达式中的标识符（如 ENABLE_EXT_DEVICE_LG_OLED）保持 VS Code 默认选词
            const selStart = selection.start.character;
            const selEnd = selection.end.character;
            if (!(selEnd > 0 && selStart < directive.end)) {
                log(`[双击拦截] 未落在指令词上`);
                lastState = undefined;
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

            const lines = editor.document.getText().split(/\r?\n/);
            const whole = locateMacroBlock(lines, activeLine);
            if (!whole) {
                log(`[双击拦截] 未找到所属条件编译块`);
                lastState = undefined;
                return;
            }
            const branch = getBranchRange(lines, whole, activeLine);
            const now = Date.now();

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
