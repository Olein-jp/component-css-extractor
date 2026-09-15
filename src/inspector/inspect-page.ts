import { isSimpleCompound, selectorClasses, selectorForStateMatching, simpleSpecificity, splitSelectorList, stripSupportedSuffix } from '../css/selectors';
import { extractTopLevelImports } from '../css/imports';
import { stylesheetLabel, type StylesheetDiagnostic } from '../css/stylesheet-diagnostics';
import { varReferences } from '../css/custom-properties';
import type { AnalyzeOptions, Declaration, ElementNode, PageSnapshot, RuleContext, SourceRule } from '../model/types';

function serializeNode(element: Element, id: string, parentId: string | null): ElementNode {
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes)) attributes[attribute.name] = attribute.value;
  return { id, parentId, tagName: element.tagName.toLowerCase(), classes: Array.from(element.classList), attributes };
}

function collectNodes(root: Element, includeDescendants: boolean, warnings: string[]): { nodes: ElementNode[]; elements: Map<string, Element> } {
  const nodes: ElementNode[] = [];
  const elements = new Map<string, Element>();
  const queue: Array<{ element: Element; id: string; parentId: string | null }> = [{ element: root, id: '0', parentId: null }];
  while (queue.length && nodes.length < 250) {
    const current = queue.shift();
    if (!current) break;
    nodes.push(serializeNode(current.element, current.id, current.parentId));
    elements.set(current.id, current.element);
    if (includeDescendants) {
      Array.from(current.element.children).forEach((child, index) => queue.push({ element: child, id: `${current.id}.${index}`, parentId: current.id }));
    }
  }
  if (queue.length) warnings.push('子孫要素が250件を超えたため、先頭の250件を解析しました。');
  return { nodes, elements };
}

function contextFor(rule: CSSRule): RuleContext {
  const header = rule.cssText.slice(0, rule.cssText.indexOf('{')).trim();
  const type = header.startsWith('@media') ? 'media' : header.startsWith('@supports') ? 'supports'
    : header.startsWith('@container') ? 'container' : header.startsWith('@layer') ? 'layer' : 'other';
  return { type, header };
}

function hasNestedRules(rule: CSSRule): rule is CSSRule & { cssRules: CSSRuleList } {
  return 'cssRules' in rule && typeof (rule as CSSRule & { cssRules?: unknown }).cssRules === 'object';
}

export function inspectPage(options: AnalyzeOptions, selected: Element | null, fallbackStylesheets: Record<string, string> = {}): PageSnapshot {
  const warnings: string[] = [];
  if (options.mode === 'selected' && selected?.nodeType !== 1) {
    return { nodes: [], rules: [], warnings, selectedLabel: '', originalHtml: '' };
  }
  const result = options.mode === 'manual'
    ? { nodes: [{ id: '0', parentId: null, tagName: 'div', classes: options.manualClasses, attributes: {} }], elements: new Map<string, Element>() }
    : collectNodes(selected as Element, options.includeDescendants, warnings);
  const { nodes, elements } = result;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const classNodes = new Map<string, Set<string>>();
  for (const node of nodes) for (const className of node.classes) {
    const ids = classNodes.get(className) ?? new Set<string>();
    ids.add(node.id);
    classNodes.set(className, ids);
  }
  const rules: SourceRule[] = [];
  let sourceOrder = 0;
  let skippedSelectors = 0;
  let recoveredStylesheets = 0;
  const unreadableStylesheets: string[] = [];
  const stylesheetDiagnostics: StylesheetDiagnostic[] = [];
  const unresolvedImports = new Set<string>();
  const unsupportedImports = new Set<string>();
  const cyclicImports = new Set<string>();
  const visitedSheets = new Set<CSSStyleSheet>();
  let detachedRoot: Element | null | undefined;
  function needsOuterContext(nodeId: string, selector: string): boolean {
    if (options.mode !== 'selected') return false;
    if (detachedRoot === undefined) {
      try { detachedRoot = (selected as Element).cloneNode(true) as Element; }
      catch { detachedRoot = null; }
    }
    if (!detachedRoot) return false;
    let copy: Element | null = detachedRoot;
    for (const index of nodeId.split('.').slice(1).map(Number)) copy = copy?.children.item(index) ?? null;
    try { return copy ? !copy.matches(selector) : false; }
    catch { return false; }
  }
  function traverse(list: CSSRuleList, contexts: RuleContext[], onMarker?: (selector: string, contexts: RuleContext[]) => boolean): void {
    for (const rule of Array.from(list)) {
      if (rule.type === 1 && 'selectorText' in rule && 'style' in rule) {
        const styleRule = rule as CSSStyleRule;
        if (onMarker?.(styleRule.selectorText, contexts)) continue;
        const order = sourceOrder++;
        const declarations: Declaration[] = [];
        for (let i = 0; i < styleRule.style.length; i++) {
          const property = styleRule.style.item(i);
          declarations.push({ property, value: styleRule.style.getPropertyValue(property).trim(), important: styleRule.style.getPropertyPriority(property) === 'important', sourceOrder: order });
        }
        if (!declarations.length) continue;
        for (const selector of splitSelectorList(styleRule.selectorText)) {
          const selectorNames = selectorClasses(selector);
          if (!selectorNames.some((name) => classNodes.has(name))) continue;
          const parts = stripSupportedSuffix(selector);
          if (!parts || !isSimpleCompound(parts.base)) {
            if (options.mode === 'manual') { skippedSelectors++; continue; }
            const matchSelector = selectorForStateMatching(selector);
            for (const node of nodes) {
              const element = elements.get(node.id);
              if (!element) continue;
              try {
                if (element.matches(matchSelector)) {
                  rules.push({ nodeId: node.id, originalSelector: selector, suffix: '', specificity: 0,
                    contexts, declarations, sourceOrder: order, preserveSelector: true,
                    externalDependency: needsOuterContext(node.id, matchSelector) });
                }
              } catch { skippedSelectors++; }
            }
            continue;
          }
          const names = selectorClasses(parts.base);
          if (!names.length) continue;
          const candidates = new Set<string>();
          for (const name of names) for (const id of classNodes.get(name) ?? []) candidates.add(id);
          for (const id of candidates) {
            const node = nodeById.get(id);
            if (!node || !names.every((name) => node.classes.includes(name))) continue;
            const element = elements.get(id);
            if (element) {
              try { if (!element.matches(parts.base)) continue; }
              catch { skippedSelectors++; continue; }
            }
            rules.push({ nodeId: id, originalSelector: selector, suffix: parts.suffix,
              specificity: simpleSpecificity(parts.base), contexts, declarations, sourceOrder: order });
          }
        }
      } else if (rule.type === 3 && 'styleSheet' in rule) {
        const importRule = rule as CSSImportRule;
        const imported = importRule.styleSheet;
        const media = importRule.media?.mediaText?.trim();
        const importContexts: RuleContext[] = media && media !== 'all' ? [...contexts, { type: 'media', header: `@media ${media}` }] : contexts;
        if (imported) visitSheet(imported, importContexts);
      } else if (hasNestedRules(rule)) {
        traverse(rule.cssRules, [...contexts, contextFor(rule)], onMarker);
      }
    }
  }
  function visitFallback(url: string, cssText: string, contexts: RuleContext[], stack: Set<string>): void {
    const extracted = extractTopLevelImports(cssText);
    const byMarker = new Map(extracted.imports.map((item) => [item.marker, item]));
    const parsed = new CSSStyleSheet();
    parsed.replaceSync(extracted.cssText);
    if (cssText.trim() && !parsed.cssRules.length) throw new Error('No CSS rules parsed');
    traverse(parsed.cssRules, contexts, (selector, currentContexts) => {
      const imported = byMarker.get(selector);
      if (!imported) return false;
      if (imported.unsupported || !imported.href) { unsupportedImports.add(`${url}:${selector}`); return true; }
      let importedUrl: string;
      try { importedUrl = new URL(imported.href, url).href; }
      catch { unresolvedImports.add(`${url}:${selector}`); return true; }
      if (stack.has(importedUrl)) { cyclicImports.add(importedUrl); return true; }
      const importedText = fallbackStylesheets[importedUrl];
      if (importedText === undefined) { unresolvedImports.add(importedUrl); return true; }
      const mediaContexts: RuleContext[] = imported.media && imported.media !== 'all'
        ? [...currentContexts, { type: 'media', header: `@media ${imported.media}` }] : currentContexts;
      stack.add(importedUrl);
      const ruleCount = rules.length;
      const order = sourceOrder;
      const skipped = skippedSelectors;
      const recovered = recoveredStylesheets;
      try { visitFallback(importedUrl, importedText, mediaContexts, stack); }
      catch {
        rules.length = ruleCount;
        sourceOrder = order;
        skippedSelectors = skipped;
        recoveredStylesheets = recovered;
        unresolvedImports.add(importedUrl);
        if (!stylesheetDiagnostics.some((item) => item.reason === 'parse-failed' && item.label === stylesheetLabel(importedUrl))) {
          stylesheetDiagnostics.push({ reason: 'parse-failed', label: stylesheetLabel(importedUrl) });
        }
      }
      finally { stack.delete(importedUrl); }
      return true;
    });
    recoveredStylesheets++;
  }
  function visitSheet(sheet: CSSStyleSheet, contexts: RuleContext[]): void {
    if (visitedSheets.has(sheet) || sheet.disabled) return;
    visitedSheets.add(sheet);
    const ruleCount = rules.length;
    const order = sourceOrder;
    const skipped = skippedSelectors;
    try { traverse(sheet.cssRules, contexts); }
    catch {
      rules.length = ruleCount;
      sourceOrder = order;
      skippedSelectors = skipped;
      const href = sheet.href;
      const cssText = href ? fallbackStylesheets[href] : undefined;
      let parseFailed = false;
      if (cssText !== undefined && href) {
        try {
          visitFallback(href, cssText, contexts, new Set([href]));
          return;
        } catch {
          rules.length = ruleCount;
          sourceOrder = order;
          parseFailed = true;
        }
      }
      if (href) unreadableStylesheets.push(href);
      if (parseFailed) stylesheetDiagnostics.push({ reason: 'parse-failed', label: stylesheetLabel(href) });
      else if (!href) stylesheetDiagnostics.push({ reason: 'cssom-failed', label: stylesheetLabel(null) });
    }
  }
  const ownerDocument = options.mode === 'selected' ? (selected as Element).ownerDocument : document;
  for (const sheet of Array.from(ownerDocument.styleSheets)) {
    if (sheet.disabled) continue;
    const media = sheet.media?.mediaText?.trim();
    const contexts: RuleContext[] = media && media !== 'all' ? [{ type: 'media', header: `@media ${media}` }] : [];
    visitSheet(sheet, contexts);
  }
  if (unresolvedImports.size) warnings.push(`${unresolvedImports.size} 件の @import 先を補完できませんでした。`);
  if (unsupportedImports.size) warnings.push(`${unsupportedImports.size} 件の @import は layer・supports 条件または URL の形式に対応していないため省略しました。`);
  if (cyclicImports.size) warnings.push(`${cyclicImports.size} 件の循環する @import を省略しました。`);
  if (skippedSelectors) warnings.push(`${skippedSelectors} 件のセレクタは解析できず省略しました。`);
  const customPropertyValues: Record<string, Record<string, string>> = {};
  if (options.mode === 'selected') {
    const pending = rules.flatMap((sourceRule) => sourceRule.declarations.flatMap((declaration) =>
      varReferences(declaration.value).map((reference) => ({ nodeId: sourceRule.nodeId, name: reference.name }))));
    const visitedProperties = new Set<string>();
    for (const item of pending) {
      const key = `${item.nodeId}:${item.name}`;
      if (visitedProperties.has(key)) continue;
      visitedProperties.add(key);
      const element = elements.get(item.nodeId);
      if (!element) continue;
      const value = getComputedStyle(element).getPropertyValue(item.name).trim();
      if (!value) continue;
      const values = customPropertyValues[item.nodeId] ?? (customPropertyValues[item.nodeId] = {});
      values[item.name] = value;
      for (const reference of varReferences(value)) {
        const nestedKey = `${item.nodeId}:${reference.name}`;
        if (!visitedProperties.has(nestedKey)) pending.push({ nodeId: item.nodeId, name: reference.name });
      }
    }
  }
  const selectedLabel = nodes[0] ? `<${nodes[0].tagName} class="${nodes[0].classes.join(' ')}">` : '';
  return { nodes, rules, warnings, selectedLabel, originalHtml: options.mode === 'selected' ? (selected as Element).outerHTML.slice(0, 100_000) : '',
    unreadableStylesheets, recoveredStylesheets, stylesheetDiagnostics, customPropertyValues };
}

export function renderHtml(classes: Array<{ id: string; outputClass: string | null; removeClasses: string[] }>, selected: Element | null): string {
  if (selected?.nodeType !== 1) return '';
  const clone = selected.cloneNode(true) as Element;
  for (const item of classes) {
    if (!item.outputClass) continue;
    const path = item.id.split('.').slice(1).map(Number);
    let target: Element | undefined = clone;
    for (const index of path) target = target?.children.item(index) ?? undefined;
    if (target) {
      const preserved = Array.from(target.classList).filter((name) => !item.removeClasses.includes(name));
      target.setAttribute('class', [...new Set([...preserved, item.outputClass])].join(' '));
    }
  }
  return clone.outerHTML.slice(0, 100_000);
}
