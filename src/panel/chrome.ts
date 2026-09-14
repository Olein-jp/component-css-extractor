import type { AnalyzeOptions, PageSnapshot } from '../model/types';

let inspectorScript: Promise<string> | undefined;

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
  return evaluate<PageSnapshot>(`((selected) => { ${source}\n return __componentCssInspector.inspectPage(${JSON.stringify(options)}, selected); })(typeof $0 === 'undefined' ? null : $0)`);
}

export async function renderHtml(nodes: Array<{ id: string; outputClass: string | null; removeClasses: string[] }>, mode: 'selected' | 'manual'): Promise<string> {
  if (mode === 'manual') return '';
  const source = await script();
  return evaluate<string>(`((selected) => { ${source}\n return __componentCssInspector.renderHtml(${JSON.stringify(nodes)}, selected); })(typeof $0 === 'undefined' ? null : $0)`);
}
