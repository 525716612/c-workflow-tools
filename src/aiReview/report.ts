import * as fs from 'fs';
import * as path from 'path';
import { SEVERITY_ORDER, STATUS_TEXT } from './types';
import type { DiffEntry, Finding, ReviewResult, ReviewStatusRecord, Severity } from './types';

/**
 * 结果处理：解析模型输出 → 规范化 → 渲染报告 → 落盘状态/历史。
 * 落盘产物与旧版保持一致，IDE 弹窗仍读 last-status.json。
 */

/** 从模型输出里抽取 JSON（容忍 markdown 代码块与前后废话） */
export function extractJson(text: string): Record<string, unknown> | undefined {
    const candidates: string[] = [];
    for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
        candidates.push(match[1].trim());
    }
    candidates.push(text.trim());
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
        candidates.push(text.slice(start, end + 1));
    }
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate) as Record<string, unknown>;
            if (parsed && typeof parsed === 'object' && ('findings' in parsed || 'summary' in parsed)) {
                return parsed;
            }
        } catch {
            // 继续试下一个候选
        }
    }
    return undefined;
}

function toSeverity(value: unknown): Severity {
    const text = String(value ?? 'low').toLowerCase();
    return text === 'high' || text === 'medium' ? text : 'low';
}

function pick(item: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = item[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

/** 规范化模型输出（容忍字段别名、非法严重级别） */
export function normalize(parsed: Record<string, unknown>): ReviewResult {
    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const findings: Finding[] = [];
    for (const item of rawFindings) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const record = item as Record<string, unknown>;
        findings.push({
            severity: toSeverity(record.severity),
            file: String(record.file ?? '?'),
            line: String(record.line ?? ''),
            title: pick(record, ['title', 'issue']),
            detail: pick(record, ['detail', 'description']),
            suggestion: pick(record, ['suggestion', 'fix']),
        });
    }
    findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]
        || a.file.localeCompare(b.file));
    return {
        summary: String(parsed.summary ?? '').trim(),
        risk: String(parsed.risk ?? '').trim().toLowerCase(),
        findings,
    };
}

/** 统计各级别数量 */
export function countBySeverity(findings: Finding[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const finding of findings) {
        counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
    }
    return counts;
}

export interface ReportMeta {
    repo: string;
    scope: string;
    /** 本次审查对应的 HEAD（短 sha），写进报告以区分"这是哪一次的审查" */
    head: string;
    files: number;
    added: number;
    deleted: number;
    backend: string;
    elapsed: number;
    notes: string[];
}

/** 终端风格纯文本报告 */
export function renderText(result: ReviewResult, meta: ReportMeta, rawText = ''): string {
    const lines: string[] = [];
    lines.push('='.repeat(72));
    lines.push(' AI Code Review');
    lines.push(` repo: ${meta.repo}  |  scope: ${meta.scope}`);
    lines.push(` files: ${meta.files}  |  +${meta.added} -${meta.deleted}  |  `
        + `backend: ${meta.backend}  |  ${meta.elapsed.toFixed(1)}s`);
    lines.push('='.repeat(72));
    if (rawText && result.findings.length === 0 && !result.summary) {
        lines.push('模型未返回可解析的 JSON，原始输出如下：');
        lines.push(rawText.trim() || '(空)');
        return lines.join('\n');
    }
    if (result.summary) {
        lines.push(`Summary: ${result.summary}`);
    }
    if (result.risk) {
        lines.push(`Risk: ${result.risk}`);
    }
    const counts = countBySeverity(result.findings);
    const countText = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ');
    lines.push(`Findings: ${countText || 'none'}`);
    for (const finding of result.findings) {
        lines.push('');
        lines.push(`[${finding.severity.toUpperCase()}] ${finding.file}${finding.line ? `:${finding.line}` : ''}`
            + (finding.title ? `  ${finding.title}` : ''));
        if (finding.detail) {
            lines.push(`   问题: ${finding.detail}`);
        }
        if (finding.suggestion) {
            lines.push(`   建议: ${finding.suggestion}`);
        }
    }
    return lines.join('\n');
}

/** Markdown 报告（写入 last-report.md，供 IDE 预览） */
export function renderMarkdown(result: ReviewResult, meta: ReportMeta, rawText = ''): string {
    const lines: string[] = [];
    lines.push('# AI 代码审查报告');
    lines.push('');
    lines.push(`- 仓库：\`${meta.repo}\``);
    lines.push(`- 范围：${meta.scope}`);
    lines.push(`- 提交：\`${meta.head || '未知'}\``);
    lines.push(`- 文件：${meta.files} 个，+${meta.added} -${meta.deleted} 行`);
    lines.push(`- 后端：${meta.backend}，耗时 ${meta.elapsed.toFixed(1)}s`);
    lines.push(`- 时间：${new Date().toLocaleString()}`);
    lines.push('');
    if (meta.notes.length > 0) {
        lines.push('## 收集说明');
        lines.push('');
        for (const note of meta.notes) {
            lines.push(`- ${note}`);
        }
        lines.push('');
    }
    if (result.summary) {
        lines.push('## 结论');
        lines.push('');
        lines.push(result.summary);
        lines.push('');
    }
    const counts = countBySeverity(result.findings);
    const countText = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('，');
    lines.push('## 问题');
    lines.push('');
    if (result.findings.length === 0) {
        lines.push(rawText ? '模型未返回可解析的 JSON，原始输出见文末。' : '未发现问题。');
        lines.push('');
    }
    if (countText) {
        lines.push(`分级统计：${countText}`);
        lines.push('');
    }
    for (const finding of result.findings) {
        lines.push(`### [${finding.severity.toUpperCase()}] ${finding.file}`
            + `${finding.line ? `:${finding.line}` : ''} — ${finding.title || '(无标题)'}`);
        lines.push('');
        if (finding.detail) {
            lines.push(`**问题**：${finding.detail}`);
            lines.push('');
        }
        if (finding.suggestion) {
            lines.push(`**建议**：${finding.suggestion}`);
            lines.push('');
        }
    }
    if (rawText) {
        lines.push('## 模型原始输出');
        lines.push('');
        lines.push('```');
        lines.push(rawText.trim());
        lines.push('```');
    }
    return lines.join('\n');
}

/**
 * 「未审查」报告：跳过 / 超时 / 失败 / 后端不可用时也要写一份。
 *
 * 原因：last-report.md 是覆盖写的，不写的话它会一直停在上一份（成功的）旧报告上，
 * 用户点「打开报告」看到的就是很久以前的内容，也无法知道这次到底审了哪些文件。
 */
export function renderUnreviewedReport(
    meta: ReportMeta,
    reason: string,
    entries: DiffEntry[] = [],
    skipped: string[] = []
): string {
    const lines: string[] = [];
    lines.push('# AI 代码审查报告（未审查）');
    lines.push('');
    lines.push(`- 仓库：\`${meta.repo}\``);
    lines.push(`- 范围：${meta.scope}`);
    lines.push(`- 提交：\`${meta.head || '未知'}\``);
    lines.push(`- 文件：${meta.files} 个，+${meta.added} -${meta.deleted} 行`);
    lines.push(`- 后端：${meta.backend}，耗时 ${meta.elapsed.toFixed(1)}s`);
    lines.push(`- 时间：${new Date().toLocaleString()}`);
    lines.push('');
    lines.push(`> 本次改动**没有被审查**（${reason}）。下面的内容只是收集到的改动范围，不代表审查结论。`);
    lines.push('');
    if (entries.length > 0) {
        lines.push('## 本次待审查的文件');
        lines.push('');
        for (const entry of entries) {
            const from = entry.commit ? `（提交 ${entry.commit.slice(0, 8)}）` : '';
            lines.push(`- \`${entry.path}\` +${entry.added} -${entry.deleted}${from}`);
        }
        lines.push('');
    }
    if (meta.notes.length > 0) {
        lines.push('## 收集说明');
        lines.push('');
        for (const note of meta.notes) {
            lines.push(`- ${note}`);
        }
        lines.push('');
    }
    if (skipped.length > 0) {
        lines.push(`## 跳过的文件（${skipped.length} 个，非源码/二进制）`);
        lines.push('');
        for (const name of skipped.slice(0, 50)) {
            lines.push(`- \`${name}\``);
        }
        if (skipped.length > 50) {
            lines.push(`- …… 其余 ${skipped.length - 50} 个略`);
        }
        lines.push('');
    }
    return lines.join('\n');
}

export interface ArtifactPaths {
    stateDir: string;
    statusFile: string;
    reportFile: string;
    historyFile: string;
}

/** 组装产物路径（<git-dir>/ai-review/） */
export function artifactPaths(stateDir: string): ArtifactPaths {
    return {
        stateDir,
        statusFile: path.join(stateDir, 'last-status.json'),
        reportFile: path.join(stateDir, 'last-report.md'),
        historyFile: path.join(stateDir, 'history.log'),
    };
}

// ---------------------------------------------------------------------------
// 已审查提交记录（避免合并/同步时把审过的提交再审一遍）
// ---------------------------------------------------------------------------

/** 已审提交记录最多保留的条数（超出丢最旧的，避免文件无限增长） */
const MAX_REVIEWED_COMMITS = 2000;

/** 已审提交记录文件路径 */
export function reviewedCommitsFile(stateDir: string): string {
    return path.join(stateDir, 'reviewed-commits.log');
}

/** 读取本插件已审查过的提交 sha */
export function readReviewedCommits(stateDir: string): Set<string> {
    try {
        const raw = fs.readFileSync(reviewedCommitsFile(stateDir), 'utf8');
        return new Set(raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    } catch {
        return new Set();
    }
}

/**
 * 记录本次已审查的提交（追加 + 去重 + 保留最近若干条）。
 * 写失败不影响审查结论，只是下次可能重复审一次。
 */
export function markReviewedCommits(stateDir: string, shas: string[]): void {
    const valid = shas.filter((sha) => Boolean(sha));
    if (valid.length === 0) {
        return;
    }
    try {
        fs.mkdirSync(stateDir, { recursive: true });
        const known = readReviewedCommits(stateDir);
        for (const sha of valid) {
            known.add(sha);
        }
        const all = [...known];
        const kept = all.length > MAX_REVIEWED_COMMITS ? all.slice(all.length - MAX_REVIEWED_COMMITS) : all;
        fs.writeFileSync(reviewedCommitsFile(stateDir), kept.join('\n') + '\n', 'utf8');
    } catch {
        // 记录不了就下次重新审，不影响本次结论
    }
}

/** 写 last-status.json / last-report.md / history.log（任何一步失败都不影响审查结论） */
export function writeArtifacts(stateDir: string, record: ReviewStatusRecord, report: string): string {
    const files = artifactPaths(stateDir);
    let reportPath = '';
    try {
        fs.mkdirSync(stateDir, { recursive: true });
    } catch {
        return '';
    }
    try {
        fs.writeFileSync(files.statusFile, JSON.stringify(record, null, 2), 'utf8');
    } catch {
        // 状态写不了也要继续
    }
    if (report) {
        try {
            fs.writeFileSync(files.reportFile, report, 'utf8');
            reportPath = files.reportFile;
        } catch {
            // 报告写不了不影响弹窗
        }
    }
    try {
        const counts = Object.entries(record.counts).map(([k, v]) => `${k}=${v}`).join(' ');
        const line = `${record.time} status=${record.status} scope=${record.scope}`
            + ` files=${record.files} +${record.added} -${record.deleted}`
            + (counts ? ` ${counts}` : '')
            + (record.detail ? ` 说明=${record.detail}` : '')
            + ` head=${record.head}`;
        fs.appendFileSync(files.historyFile, line + '\n', 'utf8');
    } catch {
        // 历史写不了不影响
    }
    return reportPath;
}

/** 组装状态记录 */
export function buildRecord(params: {
    repo: string;
    scope: ReviewStatusRecord['scope'];
    head: string;
    status: ReviewStatusRecord['status'];
    detail?: string;
    meta: ReportMeta;
    counts?: Record<string, number>;
    risk?: string;
    summary?: string;
    degraded?: string;
    label?: string;
}): ReviewStatusRecord {
    const { meta } = params;
    return {
        time: new Date().toLocaleString(),
        status: params.status,
        status_text: STATUS_TEXT[params.status],
        detail: params.detail ?? '',
        head: params.head,
        repo: params.repo,
        scope: params.scope,
        label: params.label ?? '',
        files: meta.files,
        added: meta.added,
        deleted: meta.deleted,
        backend: meta.backend,
        elapsed: Number(meta.elapsed.toFixed(2)),
        risk: params.risk ?? '',
        counts: params.counts ?? {},
        degraded: params.degraded ?? '',
        summary: params.summary ?? '',
    };
}
