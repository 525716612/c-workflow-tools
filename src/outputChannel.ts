import * as vscode from 'vscode';

/**
 * 全局输出通道工具，供所有功能模块复用日志输出。
 * 每个功能模块独立，通过此模块共享输出通道。
 */
let channel: vscode.OutputChannel | undefined;

/**
 * 初始化输出通道（在 activate 时调用一次）。
 */
export function initOutputChannel(name: string): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel(name);
    }
    return channel;
}

/**
 * 获取全局输出通道实例；未初始化时自动创建。
 */
export function getChannel(): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('C Workflow Tools');
    }
    return channel;
}

/** 时间前缀：同一句话反复出现时（如重复失败）能看清新旧，避免误以为日志没更新 */
function stamp(): string {
    const now = new Date();
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/**
 * 向输出通道写入一行普通日志。
 */
export function log(message: string): void {
    getChannel().appendLine(`[${stamp()}] ${message}`);
}

/**
 * 向输出通道写入一行错误日志（带 [错误] 前缀并醒目显示）。
 */
export function logError(message: string): void {
    getChannel().appendLine(`[${stamp()}] [错误] ${message}`);
}

/**
 * 显示输出通道面板。
 */
export function showChannel(): void {
    getChannel().show(true);
}
