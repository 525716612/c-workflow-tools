import * as vscode from 'vscode';
import { log, showChannel } from '../outputChannel';

/**
 * 符号搜索诊断命令：输出 C/C++ 语言服务器状态与各级符号搜索统计，
 * 用于排查「搜不到符号」问题。
 */
export async function diagnoseSymbolSearch(): Promise<void> {
    showChannel();
    log('===== 符号搜索诊断开始 =====');

    // 1. 工作区状态
    const folders = vscode.workspace.workspaceFolders;
    log(`工作区: ${folders ? folders.map((f) => f.name).join(', ') : '（无）'}`);
    if (!folders || folders.length === 0) {
        log('错误：未打开工作区，无法搜索');
        return;
    }

    // 2. 打开的 C/C++ 文档
    const cDocs = vscode.window.visibleTextEditors
        .map((e) => e.document)
        .filter((d) => d.languageId === 'c' || d.languageId === 'cpp' || d.languageId === 'cuda-cpp');
    log(`当前打开的 C/C++ 文档: ${cDocs.length} 个`);

    // 3. 语言服务器（C/C++ 扩展）是否启用
    const cpptools = vscode.extensions.getExtension('ms-vscode.cpptools');
    log(
        cpptools
            ? `C/C++ 扩展: 已安装（版本 ${cpptools.packageJSON?.version ?? '未知'}，${cpptools.isActive ? '已激活' : '未激活'}）`
            : 'C/C++ 扩展: 未安装（建议安装 ms-vscode.cpptools 以获得完整符号索引）'
    );

    // 4. 工作区符号搜索（#）
    try {
        const t0 = Date.now();
        const infos = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            'app'
        );
        const elapsed = Date.now() - t0;
        if (infos === undefined || infos === null) {
            log(`工作区符号搜索(#): 无 provider 响应（${elapsed}ms）——语言服务器未注册，符号搜索不可用`);
        } else {
            log(`工作区符号搜索(#): 返回 ${infos.length} 条（${elapsed}ms）`);
            infos.slice(0, 10).forEach((s) => {
                const kind = vscode.SymbolKind[s.kind] ?? s.kind;
                log(`  - [${kind}] ${s.name}  ${vscode.workspace.asRelativePath(s.location.uri)}:${s.location.range.start.line + 1}`);
            });
            if (infos.length > 10) {
                log(`  ... 等 ${infos.length} 条`);
            }
        }
    } catch (err) {
        log(`工作区符号搜索(#): 命令异常 ${String(err)}`);
    }

    // 5. 打开文档的 document symbol
    for (const doc of cDocs.slice(0, 5)) {
        try {
            const t0 = Date.now();
            const symbols = await vscode.languages.executeDocumentSymbolProvider(doc.uri);
            const elapsed = Date.now() - t0;
            log(`文档符号 ${vscode.workspace.asRelativePath(doc.uri)}: ${symbols ? symbols.length : 0} 条（${elapsed}ms）`);
        } catch (err) {
            log(`文档符号 ${vscode.workspace.asRelativePath(doc.uri)}: 异常 ${String(err)}`);
        }
    }

    // 6. 工作区文件统计（C/C++ 源文件）
    try {
        const files = await vscode.workspace.findFiles('**/*.{c,h,cpp,hpp,cc,cxx,hh}', undefined, 100000);
        log(`工作区 C/C++ 源文件: ${files.length} 个`);
    } catch (err) {
        log(`查找源文件: 异常 ${String(err)}`);
    }

    log('===== 符号搜索诊断结束 =====');
    log('将以上输出提供给开发者，可快速定位「搜不到」的原因。');
}
