import type { AnalyzeOptions, PageSnapshot } from '../model/types';
import { extractTopLevelImports } from '../css/imports';
import { formatStylesheetDiagnostics, stylesheetLabel, type StylesheetDiagnostic } from '../css/stylesheet-diagnostics';

let inspectorScript: Promise<string> | undefined;
const MAX_STYLESHEET_LENGTH = 8_000_000;
const MAX_TOTAL_LENGTH = 16_000_000;

async function script(): Promise<string> {
  inspectorScript ??= fetch(chrome.runtime.getURL('inspect-page.js')).then(async (response) => {
    if (!response.ok) throw new Error('解析スクリプトを読み込めませんでした。');
    return response.text();
  });
  return inspectorScript;
}

function evaluate<T>(expression: string): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result, exceptionInfo) => {
      if (exceptionInfo?.isError || exceptionInfo?.isException) {
        reject(new Error(exceptionInfo.description || exceptionInfo.value || '検査対象ページでの処理に失敗しました。'));
      } else resolve(result as T);
    });
  });
}

export async function readSelection(): Promise<{ tagName: string; classes: string[] } | null> {
  return evaluate<{ tagName: string; classes: string[] } | null>(
    'typeof $0 === "undefined" || !$0 || $0.nodeType !== 1 ? null : { tagName: $0.tagName.toLowerCase(), classes: Array.from($0.classList) }'
  );
}

export async function inspect(options: AnalyzeOptions): Promise<PageSnapshot> {
  const source = await script();
  const evaluateSnapshot = (fallback: Record<string, string>): Promise<PageSnapshot> => evaluate<PageSnapshot>(
    `((selected) => { ${source}\n return __componentCssInspector.inspectPage(${JSON.stringify(options)}, selected, ${JSON.stringify(fallback)}); })(typeof $0 === 'undefined' ? null : $0)`
  );
  const initial = await evaluateSnapshot({});
  const urls = [...new Set(initial.unreadableStylesheets ?? [])];
  if (!urls.length) return { ...initial, warnings: [...initial.warnings, ...formatStylesheetDiagnostics(initial.stylesheetDiagnostics ?? [])] };
  let resourceResult: Awaited<ReturnType<typeof readStyleResources>>;
  try {
    resourceResult = await readStyleResources(urls);
  } catch {
    const diagnostics: StylesheetDiagnostic[] = urls.map((url) => ({ reason: 'content-failed', label: stylesheetLabel(url) }));
    return { ...initial, warnings: [...initial.warnings,
      ...formatStylesheetDiagnostics([...(initial.stylesheetDiagnostics ?? []), ...diagnostics])] };
  }
  const { stylesheets, diagnostics } = resourceResult;
  let result = initial;
  if (Object.keys(stylesheets).length) {
    try { result = await evaluateSnapshot(stylesheets); }
    catch {
      diagnostics.push(...Object.keys(stylesheets).map((url) => ({ reason: 'evaluation-failed' as const, label: stylesheetLabel(url) })));
    }
  }
  return { ...result, warnings: [...result.warnings,
    ...formatStylesheetDiagnostics([...(result.stylesheetDiagnostics ?? []), ...diagnostics])] };
}

interface ResourceContent { content: string; encoding: string }

function decodeResource(content: string, encoding: string): string {
  if (!encoding) return content;
  if (encoding !== 'base64') throw new Error('未対応のCSSエンコード形式です。');
  const binary = atob(content);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function resourceContent(resource: chrome.devtools.inspectedWindow.Resource): Promise<string> {
  return new Promise((resolve, reject) => {
    resource.getContent((response: string | ResourceContent, encoding: string) => {
      const value = typeof response === 'string' ? response : response?.content;
      const format = typeof response === 'string' ? encoding : response?.encoding;
      if (typeof value !== 'string') { reject(new Error('CSS本文を取得できませんでした。')); return; }
      try { resolve(decodeResource(value, format ?? '')); }
      catch (error) { reject(error); }
    });
  });
}

export async function readStyleResources(urls: string[]): Promise<{ stylesheets: Record<string, string>; diagnostics: StylesheetDiagnostic[] }> {
  const resources = await new Promise<chrome.devtools.inspectedWindow.Resource[]>((resolve) => {
    chrome.devtools.inspectedWindow.getResources((items) => resolve(items ?? []));
  });
  const byUrl = new Map(resources.map((resource) => [resource.url, resource]));
  const stylesheets: Record<string, string> = {};
  const diagnostics: StylesheetDiagnostic[] = [];
  let totalLength = 0;
  const pending = [...urls];
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const url = pending[index];
    if (visited.has(url)) continue;
    visited.add(url);
    const resource = byUrl.get(url);
    if (!resource) {
      diagnostics.push({ reason: 'resource-missing', label: stylesheetLabel(url) });
      continue;
    }
    try {
      const content = await resourceContent(resource);
      if (content.length > MAX_STYLESHEET_LENGTH || totalLength + content.length > MAX_TOTAL_LENGTH) {
        diagnostics.push({ reason: 'size-limit', label: stylesheetLabel(url) });
        continue;
      }
      stylesheets[url] = content;
      totalLength += content.length;
      for (const imported of extractTopLevelImports(content).imports) {
        if (!imported.href || imported.unsupported) continue;
        try {
          const importedUrl = new URL(imported.href, url).href;
          if (!visited.has(importedUrl)) pending.push(importedUrl);
        } catch { /* The inspector reports an unresolved import. */ }
      }
    } catch { diagnostics.push({ reason: 'content-failed', label: stylesheetLabel(url) }); }
  }
  return { stylesheets, diagnostics };
}

export async function renderHtml(nodes: Array<{ id: string; outputClass: string | null; removeClasses: string[] }>, mode: 'selected' | 'manual'): Promise<string> {
  if (mode === 'manual') return '';
  const source = await script();
  return evaluate<string>(`((selected) => { ${source}\n return __componentCssInspector.renderHtml(${JSON.stringify(nodes)}, selected); })(typeof $0 === 'undefined' ? null : $0)`);
}
