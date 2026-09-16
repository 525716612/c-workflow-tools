import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { killProcessTree } from '../utils/proc';
import type { ReviewConfig } from './types';

/**
 * 后端：只依赖 `codebuddy` CLI（插件不内置任何 API Key 逻辑）。
 * 调用方式与旧版一致：`codebuddy -p <额外参数>`，**提示词走 stdin**
 * （提示词很长且含各种引号，走 stdin 可以完全避开命令行长度与转义问题）。
 */

/** CLI 可执行名候选 */
const CLI_NAMES = ['codebuddy', 'cbc'];

/** 默认屏蔽的工具：提示词是自包含的，禁掉工具可避免交互式授权弹窗把审查卡死 */
export const DEFAULT_DENY_TOOLS = 'Bash,Write,Edit,Read,Glob,Grep,WebFetch,WebSearch';

export interface BackendInfo {
    /** 可用则为 CLI 路径，不可用为空 */
    cliPath: string;
    /** 展示用说明 */
    detail: string;
    available: boolean;
}

/** 在 PATH 中查找可执行文件（不依赖 shell，兼容 Windows 的 .cmd/.exe） */
function lookupOnPath(name: string): string | undefined {
    if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
        return fs.existsSync(name) ? name : undefined;
    }
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    const names = process.platform === 'win32'
        ? [name, ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
            .split(';')
            .filter(Boolean)
            .map((ext) => name + ext.toLowerCase())]
        : [name];
    for (const dir of dirs) {
        for (const candidate of names) {
            const full = path.join(dir, candidate);
            try {
                if (fs.statSync(full).isFile()) {
                    return full;
                }
            } catch {
                // 继续找
            }
        }
    }
    return undefined;
}

/** 定位 codebuddy CLI；找不到返回 undefined */
export function findCli(explicit = ''): string | undefined {
    if (explicit.trim()) {
        return lookupOnPath(explicit.trim());
    }
    for (const name of CLI_NAMES) {
        const found = lookupOnPath(name);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/** 解析后端可用性（启动闸门之一） */
export function resolveBackend(cfg: ReviewConfig): BackendInfo {
    const cliPath = findCli(cfg.cliPath);
    if (!cliPath) {
        return {
            cliPath: '',
            available: false,
            detail: cfg.cliPath
                ? `设置里的 codebuddy 路径不存在：${cfg.cliPath}`
                : '未找到 codebuddy CLI（请先 npm install -g @tencent-ai/codebuddy-code）',
        };
    }
    return { cliPath, available: true, detail: cliPath };
}

/**
 * Windows 下 .cmd/.bat 是批处理 shim，CreateProcess 无法直接执行，需要经 cmd.exe。
 * （这也是"假死"的根源：kill 掉 cmd.exe 后真正干活的 node 子进程还活着。）
 */
function wrapWindowsShim(command: string, args: string[]): { command: string; args: string[] } {
    if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
        return { command: process.env.COMSPEC ?? 'cmd.exe', args: ['/c', command, ...args] };
    }
    return { command, args };
}

export interface CliCallResult {
    stdout: string;
    /** 已运行毫秒数 */
    elapsedMs: number;
}

/**
 * 调用 CLI 并把提示词写进 stdin。
 * 超时会结束整棵进程树（否则 cmd.exe 下的 node 会一直挂着）。
 */
export function callCli(cliPath: string, prompt: string, cfg: ReviewConfig): Promise<CliCallResult> {
    const args = ['-p', ...cfg.cliArgs];
    const wrapped = wrapWindowsShim(cliPath, args);
    const timeoutMs = Math.max(5, cfg.timeoutSec) * 1000;
    const started = Date.now();

    return new Promise<CliCallResult>((resolve, reject) => {
        const child = spawn(wrapped.command, wrapped.args, {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timedOut = false;

        const settle = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            action();
        };
        const timer = setTimeout(() => {
            timedOut = true;
            killProcessTree(child);
            settle(() => reject(new Error(`__TIMEOUT__ AI 调用超时（${cfg.timeoutSec}s）`)));
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
        child.stderr.on('data', (d: Buffer) => {
            if (stderr.length < 16 * 1024) { stderr += d.toString('utf8'); }
        });
        child.on('error', (e: Error) => settle(() => reject(new Error(`无法启动 codebuddy CLI：${e.message}`))));
        child.on('close', (code) => {
            settle(() => {
                const out = stdout.trim();
                if (out) {
                    resolve({ stdout: out, elapsedMs: Date.now() - started });
                    return;
                }
                const tail = stderr.trim().slice(-800);
                if (timedOut) {
                    reject(new Error('__TIMEOUT__ AI 调用超时'));
                    return;
                }
                reject(new Error(code === 0
                    ? 'codebuddy CLI 没有返回任何内容'
                    : `codebuddy CLI 退出码 ${code}：${tail || '无错误输出'}`));
            });
        });

        // 提示词整段写进 stdin；写完关闭，CLI 才会开始处理
        if (child.stdin) {
            child.stdin.on('error', () => {
                // CLI 提前退出时写 stdin 会 EPIPE，属正常路径，错误由 close 分支处理
            });
            child.stdin.end(prompt, 'utf8');
        }
    });
}
