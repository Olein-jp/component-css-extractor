import { escapeCssIdentifier, selectorClasses } from './selectors';
import type { Declaration, GeneratedOutput, OutputNode, PageSnapshot, RuleContext, SourceRule } from '../model/types';

export type Strategy = 'meaningful' | 'generated' | 'dom';

export interface GenerateOptions {
  rootClass: string;
  strategy: Strategy;
  includeMedia: boolean;
  includePseudoClasses: boolean;
  includePseudoElements: boolean;
  includeSupports: boolean;
  includeContainer: boolean;
  includeLayer: boolean;
  includeCustomProperties: boolean;
}

function preferredChildName(tagName: string): string {
  if (/^h[1-6]$/.test(tagName)) return 'title';
  if (tagName === 'p') return 'description';
  if (tagName === 'img') return 'image';
  return tagName;
}

function outputNodes(snapshot: PageSnapshot, options: GenerateOptions): OutputNode[] {
  const usedClasses = new Set(snapshot.rules.flatMap((rule) => selectorClasses(rule.originalSelector)));
  const usedNames = new Set<string>();
  const children = new Map<string, OutputNode>();
  return snapshot.nodes.map((node) => {
    if (node.id === '0') {
      const root = { ...node, outputSelector: `.${escapeCssIdentifier(options.rootClass)}`, outputClass: options.strategy === 'dom' ? null : options.rootClass };
      children.set(node.id, root);
      return root;
    }
    if (options.strategy === 'dom') {
      const parent = node.parentId ? children.get(node.parentId) : undefined;
      const index = Number(node.id.split('.').at(-1)) + 1;
      const outputSelector = `${parent?.outputSelector ?? `.${escapeCssIdentifier(options.rootClass)}`} > ${node.tagName}:nth-child(${index})`;
      const child = { ...node, outputSelector, outputClass: null };
      children.set(node.id, child);
      return child;
    }
    const meaningful = options.strategy === 'meaningful' ? node.classes.find((name) => !usedClasses.has(name)) : undefined;
    const base = meaningful ?? `${options.rootClass}__${preferredChildName(node.tagName)}`;
    let name = base;
    let counter = 2;
    while (usedNames.has(name) || name === options.rootClass) name = `${base}-${counter++}`;
    usedNames.add(name);
    const child = { ...node, outputSelector: `.${escapeCssIdentifier(name)}`, outputClass: name };
    children.set(node.id, child);
    return child;
  });
}

function contextAllowed(context: RuleContext, options: GenerateOptions): boolean {
  if (context.type === 'media') return options.includeMedia;
  if (context.type === 'supports') return options.includeSupports;
  if (context.type === 'container') return options.includeContainer;
  if (context.type === 'layer') return options.includeLayer;
  return false;
}

interface SelectedDeclaration extends Declaration { specificity: number }
interface Segment { selector: string; contexts: RuleContext[]; declarations: Map<string, SelectedDeclaration> }

function renderSegment(segment: Segment): string {
  const contextIndent = '  '.repeat(segment.contexts.length);
  let block = `${contextIndent}${segment.selector} {\n`;
  for (const declaration of segment.declarations.values()) {
    block += `${contextIndent}  ${declaration.property}: ${declaration.value}${declaration.important ? ' !important' : ''};\n`;
  }
  block += `${contextIndent}}`;
  for (let i = segment.contexts.length - 1; i >= 0; i--) {
    const indent = '  '.repeat(i);
    block = `${indent}${segment.contexts[i].header} {\n${block}\n${indent}}`;
  }
  return block;
}

function ruleAllowed(rule: SourceRule, options: GenerateOptions): boolean {
  if (!rule.contexts.every((context) => contextAllowed(context, options))) return false;
  if (rule.preserveSelector) {
    if (!options.includePseudoElements && /(?<!\\)::[a-z-]+/i.test(rule.originalSelector)) return false;
    if (!options.includePseudoClasses && /(?<![\\:]):[a-z-]+/i.test(rule.originalSelector)) return false;
  }
  if (rule.suffix.includes('::') && !options.includePseudoElements) return false;
  if (rule.suffix.replace(/::[a-z-]+/g, '').includes(':') && !options.includePseudoClasses) return false;
  return true;
}

function rewrittenRootSelector(rule: SourceRule, node: OutputNode): string | null {
  if (!rule.preserveSelector || !rule.externalDependency || node.id !== '0' || !node.outputClass) return null;
  // Only a static class on the omitted direct parent can be discarded safely.
  const parts = /^\.([_a-zA-Z][\w-]*)\s*>\s*\.([_a-zA-Z][\w-]*)((?:\[[^\[\]]+\])*)$/.exec(rule.originalSelector);
  if (!parts || !node.classes.includes(parts[2])) return null;
  if (/\[\s*class(?:\s|[~|^$*]?=|\])/i.test(parts[3])) return null;
  return `.${escapeCssIdentifier(node.outputClass)}${parts[3]}`;
}

export function generateOutput(snapshot: PageSnapshot, options: GenerateOptions): GeneratedOutput {
  const nodes = outputNodes(snapshot, options);
  const warnings = [...snapshot.warnings];
  if (options.strategy === 'dom' && snapshot.originalHtml && !snapshot.nodes[0]?.classes.includes(options.rootClass)) {
    warnings.push('DOMセレクタのルートクラスが元のHTMLにありません。既存のクラス名を指定してください。');
  }
  const blocks: string[] = [];
  const unresolvedDependencies = new Set<string>();
  for (const node of nodes) {
    const rules = snapshot.rules.filter((rule) => rule.nodeId === node.id && ruleAllowed(rule, options))
      .sort((a, b) => a.sourceOrder - b.sourceOrder);
    const segments: Segment[] = [];
    for (const rule of rules) {
      const rewritten = rewrittenRootSelector(rule, node);
      const selector = rewritten ?? (rule.preserveSelector ? rule.originalSelector : node.outputSelector + rule.suffix);
      if (rule.externalDependency && !rewritten) unresolvedDependencies.add(rule.originalSelector);
      const key = JSON.stringify([selector, rule.contexts]);
      const previous = segments.at(-1);
      const previousKey = previous ? JSON.stringify([previous.selector, previous.contexts]) : '';
      const segment = key === previousKey && previous ? previous : { selector, contexts: rule.contexts, declarations: new Map<string, SelectedDeclaration>() };
      if (segment !== previous) segments.push(segment);
      for (const declaration of rule.declarations) {
        if (!options.includeCustomProperties && declaration.property.startsWith('--')) continue;
        const existing = segment.declarations.get(declaration.property);
        const candidate: SelectedDeclaration = { ...declaration, specificity: rule.specificity };
        if (!existing || Number(candidate.important) > Number(existing.important)
          || (candidate.important === existing.important && (candidate.specificity > existing.specificity
            || (candidate.specificity === existing.specificity && candidate.sourceOrder >= existing.sourceOrder)))) {
          segment.declarations.set(declaration.property, candidate);
        }
      }
    }
    blocks.push(...segments.filter((segment) => segment.declarations.size).map(renderSegment));
  }
  if (!blocks.length) warnings.push('一致するCSSルールが見つかりませんでした。');
  if (unresolvedDependencies.size) {
    const examples = [...unresolvedDependencies].slice(0, 3).map((selector) => `「${selector}」`).join('、');
    warnings.push(`${unresolvedDependencies.size} 件のセレクタは選択範囲外の要素・状態に依存します（${examples}）。コピーしたHTMLだけではスタイルを再現できない場合があります。`);
  }
  return { css: blocks.join('\n\n'), html: snapshot.originalHtml, warnings, nodes };
}

export function htmlReplacements(snapshot: PageSnapshot, nodes: OutputNode[]): Array<{ id: string; outputClass: string; removeClasses: string[] }> {
  const retainedClasses = new Set(snapshot.rules.filter((rule) => rule.preserveSelector)
    .flatMap((rule) => {
      const node = nodes.find((item) => item.id === rule.nodeId);
      return node && rewrittenRootSelector(rule, node) ? [] : selectorClasses(rule.originalSelector);
    }));
  return nodes.filter((node): node is OutputNode & { outputClass: string } => Boolean(node.outputClass)
    && (node.id === '0' || snapshot.rules.some((rule) => rule.nodeId === node.id)))
    .map((node) => ({ id: node.id, outputClass: node.outputClass,
      removeClasses: [...new Set(snapshot.rules.filter((rule) => rule.nodeId === node.id)
        .flatMap((rule) => selectorClasses(rule.originalSelector)))].filter((name) => !retainedClasses.has(name)) }));
}
