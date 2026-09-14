export interface ExtractedImport {
  marker: string;
  href: string | null;
  media: string;
  unsupported: boolean;
}

function importDetails(statement: string): Pick<ExtractedImport, 'href' | 'media' | 'unsupported'> {
  const source = statement.replace(/^\s*@import\s+/i, '').replace(/;\s*$/, '').trim();
  let href: string | null = null;
  let remainder = '';
  const quoted = /^(["'])(.*?)\1/s.exec(source);
  if (quoted && !quoted[2].includes('\\')) {
    href = quoted[2];
    remainder = source.slice(quoted[0].length).trim();
  } else {
    const url = /^url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/is.exec(source);
    if (url && !(url[2] ?? url[3]).includes('\\')) {
      href = (url[2] ?? url[3]).trim();
      remainder = source.slice(url[0].length).trim();
    }
  }
  const unsupported = !href || /^(?:layer(?:\s*\(|\b)|supports\s*\()/i.test(remainder);
  return { href, media: unsupported ? '' : remainder, unsupported };
}

export function extractTopLevelImports(cssText: string): { cssText: string; imports: ExtractedImport[] } {
  const imports: ExtractedImport[] = [];
  const replacements: Array<{ start: number; end: number; marker: string }> = [];
  let quote = '';
  let comment = false;
  let escaped = false;
  let braces = 0;
  let parentheses = 0;
  let statementStart = 0;
  let importAllowed = true;
  for (let i = 0; i < cssText.length; i++) {
    const char = cssText[i];
    const next = cssText[i + 1];
    if (comment) {
      if (char === '*' && next === '/') { comment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') { comment = true; i++; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') { parentheses++; continue; }
    if (char === ')') { parentheses = Math.max(0, parentheses - 1); continue; }
    if (char === '{' && !parentheses) { if (!braces) importAllowed = false; braces++; continue; }
    if (char === '}' && !parentheses) { braces = Math.max(0, braces - 1); if (!braces) statementStart = i + 1; continue; }
    if (char !== ';' || braces || parentheses) continue;
    const statement = cssText.slice(statementStart, i + 1).replace(/^(?:\s|\/\*[\s\S]*?\*\/)+/, '').trim();
    if (importAllowed && /^@import\s/i.test(statement)) {
      const marker = `.__component_css_import_marker_${imports.length}__`;
      imports.push({ marker, ...importDetails(statement) });
      replacements.push({ start: statementStart, end: i + 1, marker });
    } else if (statement && !/^@(?:charset\s|layer\s+[^{};]+;)/i.test(statement)) {
      importAllowed = false;
    }
    statementStart = i + 1;
  }
  let result = cssText;
  for (const item of replacements.reverse()) {
    result = `${result.slice(0, item.start)}${item.marker} { }${result.slice(item.end)}`;
  }
  return { cssText: result, imports };
}
