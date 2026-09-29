import * as vscode from 'vscode';
import * as path from 'path';
import { evaluateGate } from './aiReviewSetup';
import { runReview } from '../aiReview/engine';
import { resolveReviewRepo } from './aiReviewWorking';
import type { ReviewOutcome } from '../aiReview/types';
import { log, logError } from '../outputChannel';

/** 语言模型工具名，须与 package.json contributes.languageModelTools 中的 name 一致 */
export const REVIEW_TOOL_NAME = 'c-workflow-tools_reviewUncommitted';

interface ReviewToolInput {
    /** 可选：git 仓库根目录绝对路径；省略则用当前文件/工作区所在仓库 */
    repo?: string;
}

/** 把审查结果压成给模型看的文本（状态 + 结论 + 问题清单） */
function summarize(outcome: ReviewOutcome): string {
    const r = outcome.record;
    const head = [
        `AI 代码审查（工作区未提交改动，git diff HEAD）：${r.status_text}`,
        `文件=${r.files} +${r.added} -${r.deleted} 风险=${r.risk || 'n/a'}`,
        r.summary ? `结论：${r.summary}` : '',
        r.detail ? `说明：${r.detail}` : '',
    ].filter(Boolean).join('\n');
    const findings = outcome.result?.findings ?? [];
    if (findings.length === 0) {
        return head;
    }
    const lines = findings.map((f) => {
        const loc = f.line ? `${f.file}:${f.line}` : f.file;
        const parts = [`[${f.severity.toUpperCase()}] ${loc} ${f.title}`];
        if (f.detail) {
            parts.push(`  问题：${f.detail}`);
        }
        if (f.suggestion) {
            parts.push(`  建议：${f.suggestion}`);
        }
        return parts.join('\n');
    });
    return `${head}\n\n${lines.join('\n\n')}`;
}

/**
 * 注册「审查未提交改动」语言模型工具：Copilot 在对话里可直接调用，
 * 对本机 codebuddy CLI 发起一次工作区审查并返回问题清单。
 */
export function registerAiReviewTool(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.lm.registerTool<ReviewToolInput>(REVIEW_TOOL_NAME, {
            prepareInvocation() {
                return { invocationMessage: '正在用 codebuddy 审查工作区未提交改动…' };
            },
            async invoke(options) {
                try {
                    const gate = evaluateGate(context);
                    if (!gate.enabled) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`AI 审查未启用：${gate.reason}`),
                        ]);
                    }
                    const repo = resolveReviewRepo(options.input?.repo);
                    if (!repo) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart('没有找到 git 仓库，无法审查未提交改动。'),
                        ]);
                    }
                    log(`AI 审查工具调用：${path.basename(repo)}（scope=working）`);
                    const outcome = await runReview({ repo, scope: 'working', cfg: gate.cfg });
                    log(`AI 审查工具调用：${outcome.record.status_text}（${outcome.message}）`);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(summarize(outcome)),
                    ]);
                } catch (e) {
                    const message = (e as Error).message;
                    logError(`AI 审查工具调用失败：${message}`);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`审查失败：${message}`),
                    ]);
                }
            },
        })
    );
}