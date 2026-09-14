export interface VarReference {
  name: string;
  hasFallback: boolean;
}

function scanQuoted(value: string, start: number, end: number): number {
  const quote = value[start];
  for (let index = start + 1; index < end; index++) {
    if (value[index] === '\\') { index++; continue; }
    if (value[index] === quote) return index + 1;
  }
  return end;
}

function scanComment(value: string, start: number, end: number): number {
  const closing = value.indexOf('*/', start + 2);
  return closing < 0 || closing >= end ? end : closing + 2;
}

function scanReferences(value: string, start: number, end: number, references: VarReference[]): void {
  for (let index = start; index < end;) {
    const char = value[index];
    if (char === '"' || char === "'") { index = scanQuoted(value, index, end); continue; }
    if (char === '/' && value[index + 1] === '*') { index = scanComment(value, index, end); continue; }
    if (value.slice(index, index + 4).toLowerCase() !== 'var('
      || (index > start && /[\w\\-]/.test(value[index - 1]))) { index++; continue; }

    const open = index + 3;
    let depth = 1;
    let comma = -1;
    let cursor = open + 1;
    for (; cursor < end; cursor++) {
      const current = value[cursor];
      if (current === '"' || current === "'") { cursor = scanQuoted(value, cursor, end) - 1; continue; }
      if (current === '/' && value[cursor + 1] === '*') { cursor = scanComment(value, cursor, end) - 1; continue; }
      if (current === '(') depth++;
      else if (current === ')') {
        depth--;
        if (depth === 0) break;
      }
      else if (current === ',' && depth === 1 && comma < 0) comma = cursor;
    }
    if (depth !== 0) { index++; continue; }
    const name = value.slice(open + 1, comma < 0 ? cursor : comma).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/^--\S+$/.test(name)) references.push({ name, hasFallback: comma >= 0 });
    if (comma >= 0) scanReferences(value, comma + 1, cursor, references);
    index = cursor + 1;
  }
}

export function varReferences(value: string): VarReference[] {
  const references: VarReference[] = [];
  scanReferences(value, 0, value.length, references);
  return references;
}
