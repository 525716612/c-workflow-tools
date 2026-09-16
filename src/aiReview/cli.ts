/**
 * 审查引擎的独立命令行入口（打包为 dist/cli.js）。
 *
 * 用途：
 *   1. 脱离 IDE 自测/排障（不需要启动扩展宿主，也不需要 Python）；
 *   2. 需要时也能被外部脚本/钩子调用（引擎本身不依赖 vscode）。
 *
 * 示例：
 *   node dist/cli.js --repo . --scope staged --dry-run
 *   node dist/cli.js --repo . --scope commit --rev HEAD
 *   node dist/cli.js --repo . --scope rebase --old <sha> --new <sha>
 *   node dist/cli.js --repo . --scope staged --cli C:/path/to/codebuddy.cmd --json
 */
import { runReview, preparePrompt, classifyHeadChange, lastAction } from './engine';
import { defaultConfig } from './types';
import type { ReviewConfig, ReviewScope } from './types';

interface CliArgs {
    repo: string;
    scope: ReviewScope | 'auto';
    rev: string;
    oldHead: string;
    newHead: string;
    dryRun: boolean;
    json: boolean;
    failOnBlock: boolean;
    cfg: ReviewConfig;
}

function parseArgs(argv: string[]): CliArgs {
    const cfg = defaultConfig();
    const args: CliArgs = {
        repo: process.cwd(),
        scope: 'auto',
        rev: '',
        oldHead: '',
        newHead: '',
        dryRun: false,
        json: false,
        failOnBlock: false,
        cfg,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = (): string => {
            i += 1;
            return argv[i] ?? '';
        };
        switch (arg) {
            case '--repo': args.repo = next(); break;
            case '--scope': args.scope = next() as CliArgs['scope']; break;
            case '--rev': args.rev = next(); break;
            case '--old': args.oldHead = next(); break;
            case '--new': args.newHead = next(); break;
            case '--cli': cfg.cliPath = next(); break;
            case '--cli-args': cfg.cliArgs = next().split(/\s+/).filter(Boolean); break;
            case '--timeout': cfg.timeoutSec = Number(next()) || cfg.timeoutSec; break;
            case '--max-files': cfg.maxFiles = Number(next()) || cfg.maxFiles; break;
            case '--max-diff-kb': cfg.maxDiffKb = Number(next()) || cfg.maxDiffKb; break;
            case '--max-commits': cfg.maxCommits = Number(next()) || cfg.maxCommits; break;
            case '--min-lines': cfg.minLines = Number(next()) || 0; break;
            case '--lang': cfg.language = next() === 'en' ? 'en' : 'zh'; break;
            case '--rules': cfg.globalRulesFile = next(); break;
            case '--block-at': cfg.blockAt = (next() as ReviewConfig['blockAt']) ?? 'high'; break;
            case '--dry-run': args.dryRun = true; break;
            case '--json': args.json = true; break;
            case '--fail-on-block': args.failOnBlock = true; break;
            default: break;
        }
    }
    return args;
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2));
    if (args.dryRun) {
        // dry-run 用空 CLI 路径即可，不会真的调用
        args.cfg.cliPath = '';
    }

    let scope: ReviewScope = args.scope === 'auto' ? 'staged' : args.scope;
    let rev = args.rev;
    if (args.scope === 'auto') {
        const head = args.newHead || 'HEAD';
        const action = await lastAction(args.repo);
        const change = await classifyHeadChange(args.repo, args.oldHead, head, action);
        if (change.scope === 'none') {
            console.log(`[ai-review] 无需审查：${change.detail}`);
            return 0;
        }
        scope = change.scope;
        rev = change.rev ?? rev;
    }

    if (args.dryRun) {
        const prepared = await preparePrompt({
            repo: args.repo, scope, rev, oldHead: args.oldHead, newHead: args.newHead, cfg: args.cfg,
        });
        if (!prepared.prompt) {
            console.log(`[ai-review] 无需审查：${prepared.reason}`);
            return 0;
        }
        console.log(prepared.prompt);
        console.error(`[ai-review] dry-run scope=${scope}：${prepared.collected.entries.length} 个文件，`
            + `+${prepared.collected.added} -${prepared.collected.deleted} 行，`
            + `prompt ${prepared.prompt.length} 字符`);
        return 0;
    }

    const outcome = await runReview({
        repo: args.repo, scope, rev, oldHead: args.oldHead, newHead: args.newHead, cfg: args.cfg,
    });
    if (args.json) {
        console.log(JSON.stringify(outcome.record, null, 2));
    } else {
        console.log(outcome.text);
        console.log('');
        console.log(`[ai-review] ${outcome.record.status_text}`
            + (outcome.reportPath ? `   报告: ${outcome.reportPath}` : ''));
    }
    if (args.failOnBlock && outcome.blockingCount > 0) {
        return 1;
    }
    return 0;
}

main()
    .then((code) => process.exit(code))
    .catch((e: Error) => {
        console.error(`[ai-review] 内部错误：${e.message}`);
        process.exit(0);
    });
