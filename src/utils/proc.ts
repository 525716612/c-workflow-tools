import { spawn, type ChildProcess } from 'child_process';

/**
 * 子进程工具：统一处理「结束进程树」与「执行并捕获输出」。
 *
 * 关键点（Windows）：`spawn(..., { shell: true })` 会先起一个 `cmd.exe`，
 * 直接 `child.kill()` 只杀掉 cmd.exe，真正的 git/python/python 脚本会变成孤儿进程
 * 继续运行 —— 属于进程/句柄泄漏。所以超时或失败清理一律走 `killProcessTree()`。
 */

/**
 * 结束子进程及其整棵子进程树。
 * Windows 用 taskkill /T /F（能连带杀掉 shell 下的真实进程），其它平台 SIGKILL。
 * 任何失败都静默忽略：清理路径上抛错没有意义。
 */
export function killProcessTree(child: ChildProcess | undefined): void {
    if (!child) {
        return;
    }
    if (process.platform === 'win32' && child.pid) {
        try {
            const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
                windowsHide: true,
                stdio: 'ignore',
            });
            // 清理用的进程不应拖住扩展宿主的事件循环
            killer.unref();
            return;
        } catch {
            // 回退到普通 kill
        }
    }
    try {
        child.kill('SIGKILL');
    } catch {
        // 进程可能已退出
    }
}

export interface CaptureResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * 执行命令并捕获输出。
 * - 超时会结束整棵进程树并 reject，不会留下后台进程；
 * - Windows 下路径含空格时自动加引号（shell: true 需要）；
 * - 非 0 退出码 reject。
 */
export function runCapture(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    onTimeoutKill?: () => void,
): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        const shell = process.platform === 'win32';
        const finalArgs = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
        const child = spawn(command, finalArgs, { cwd, shell, windowsHide: true });
        let out = '';
        let settled = false;

        const settle = (action: () => void): void => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            action();
        };

        const timer = setTimeout(() => {
            killProcessTree(child);
            onTimeoutKill?.();
            settle(() => reject(new Error(`${command} 超时（${timeoutMs}ms）`)));
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => {
            // 探测类调用输出很小；仍加个上限，避免异常进程刷爆内存
            if (out.length < 1024 * 1024) {
                out += chunk.toString('utf8');
            }
        });
        child.stderr?.on('data', () => {
            // 只需要退出码与 stdout，stderr 丢弃（内容已在错误信息里带上命令名）
        });
        child.on('error', (e) => settle(() => reject(e)));
        child.on('close', (code) => {
            settle(() => {
                if (code === 0) {
                    resolve(out);
                } else {
                    reject(new Error(`${command} 退出码 ${code}`));
                }
            });
        });
    });
}
