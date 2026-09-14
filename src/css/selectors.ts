const supportedStates = ['focus-visible', 'hover', 'focus', 'active', 'disabled', 'checked'];
const supportedElements = ['before', 'after', 'marker', 'placeholder'];

export function splitSelectorList(input: string): string[] {
  const result: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '\\') { i++; continue; }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(' || char === '[') depth++;
    if (char === ')' || char === ']') depth--;
    if (char === ',' && depth === 0) {
      result.push(input.slice(start, i).trim());
      start = i + 1;
    }
  }
  result.push(input.slice(start).trim());
  return result.filter(Boolean);
}

function readEscape(input: string, start: number): { value: string; next: number } {
  let i = start + 1;
  const hex = input.slice(i).match(/^[0-9a-fA-F]{1,6}/)?.[0];
  if (hex) {
    i += hex.length;
    if (/\s/.test(input[i] ?? '')) i++;
    const codePoint = parseInt(hex, 16);
    return { value: codePoint === 0 || codePoint > 0x10ffff ? '\uFFFD' : String.fromCodePoint(codePoint), next: i };
  }
  return { value: input[i] ?? '', next: i + 1 };
}

export function selectorClasses(selector: string): string[] {
  const classes: string[] = [];
  let quote = '';
  let bracketDepth = 0;
  for (let i = 0; i < selector.length; i++) {
    const char = selector[i];
    if (char === '\\') { i = readEscape(selector, i).next - 1; continue; }
    if (quote) { if (char === quote) quote = ''; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '[') { bracketDepth++; continue; }
    if (char === ']') { bracketDepth--; continue; }
    if (char !== '.' || bracketDepth) continue;
    let name = '';
    let j = i + 1;
    while (j < selector.length) {
      if (selector[j] === '\\') {
        const escape = readEscape(selector, j);
        name += escape.value;
        j = escape.next;
      } else if (/[-_a-zA-Z0-9\u0080-\uFFFF]/.test(selector[j])) {
        name += selector[j++];
      } else break;
    }
    if (name) classes.push(name);
    i = j - 1;
  }
  return classes;
}

export function stripSupportedSuffix(selector: string): { base: string; suffix: string } | null {
  let base = selector.trim();
  let suffix = '';
  while (true) {
    const match = base.match(/(::?)([a-z-]+)$/i);
    if (!match || (match.index !== undefined && match.index > 0 && base[match.index - 1] === '\\')) break;
    const name = match[2].toLowerCase();
    if (match[1] === '::' ? !supportedElements.includes(name) : !supportedStates.includes(name)) break;
    suffix = match[0] + suffix;
    base = base.slice(0, -match[0].length);
  }
  if (!base || /(?<!\\):/.test(base)) return null;
  return { base, suffix };
}

export function isSimpleCompound(selector: string): boolean {
  // Structural and functional selectors are deferred: rewriting them can change their meaning.
  for (let i = 0; i < selector.length; i++) {
    if (selector[i] === '\\') { i = readEscape(selector, i).next - 1; continue; }
    if (/[\s>+~\[\]():]/.test(selector[i])) return false;
  }
  return true;
}

export function simpleSpecificity(selector: string): number {
  const ids = (selector.match(/(?<!\\)#[\w-]+/g) ?? []).length;
  const classes = selectorClasses(selector).length;
  const tag = /^[a-zA-Z][\w-]*/.test(selector) ? 1 : 0;
  return ids * 100 + classes * 10 + tag;
}

export function normalizeClasses(input: string): string[] {
  return [...new Set(input.split(/[\s,]+/).map((part) => part.trim().replace(/^\./, '')).filter(Boolean))];
}

export function escapeCssIdentifier(value: string): string {
  // CSS.escape is available in Chrome, but this pure fallback keeps tests independent of the DOM.
  let escaped = value.replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0)?.toString(16)} `);
  if (/^[0-9]/.test(escaped)) escaped = `\\3${escaped[0]} ${escaped.slice(1)}`;
  if (/^-[0-9]/.test(escaped)) escaped = `-\\3${escaped[1]} ${escaped.slice(2)}`;
  if (escaped === '-') escaped = '\\-';
  return escaped;
}
