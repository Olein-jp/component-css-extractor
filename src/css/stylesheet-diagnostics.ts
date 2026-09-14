export type StylesheetFailureReason = 'resource-missing' | 'content-failed' | 'parse-failed' | 'size-limit' | 'cssom-failed' | 'evaluation-failed';

export interface StylesheetDiagnostic {
  reason: StylesheetFailureReason;
  label: string;
}

export function stylesheetLabel(rawUrl: string | null): string {
  if (!rawUrl) return 'URLのないスタイルシート';
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:', 'file:', 'chrome-extension:'].includes(url.protocol)) {
      return `${url.protocol.slice(0, -1)}形式のスタイルシート`;
    }
    const location = url.host || url.protocol.slice(0, -1);
    return `${location}${url.pathname}`.slice(0, 160);
  } catch { return 'URLを識別できないスタイルシート'; }
}

const descriptions: Record<StylesheetFailureReason, string> = {
  'resource-missing': 'DevToolsにリソースがありません。ページを再読み込みして確認してください',
  'content-failed': 'DevToolsから本文を取得できません。Networkパネルで確認してください',
  'parse-failed': '取得したCSSを解析できません。対象のCSS構文を確認してください',
  'size-limit': '容量上限を超えました。対象のCSSのサイズを確認してください',
  'cssom-failed': 'CSSOMで読み取れず、補完用のURLもありません',
  'evaluation-failed': '補完したCSSを検査対象ページで処理できません',
};

export function formatStylesheetDiagnostics(diagnostics: StylesheetDiagnostic[]): string[] {
  const grouped = new Map<StylesheetFailureReason, StylesheetDiagnostic[]>();
  for (const diagnostic of diagnostics) {
    const group = grouped.get(diagnostic.reason) ?? [];
    group.push(diagnostic);
    grouped.set(diagnostic.reason, group);
  }
  return [...grouped].map(([reason, group]) => {
    const labels = [...new Set(group.map((item) => item.label))];
    const examples = labels.slice(0, 3).join('、') + (labels.length > 3 ? ' など' : '');
    return `${group.length} 件のスタイルシートを解析できませんでした（${descriptions[reason]}）。対象: ${examples}。`;
  });
}
