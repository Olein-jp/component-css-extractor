import { isSimpleCompound, selectorClasses, selectorForStateMatching, simpleSpecificity, splitSelectorList, stripSupportedSuffix } from '../css/selectors';
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
  let preservedSelectors = 0;
  let recoveredStylesheets = 0;
  const unreadableStylesheets: string[] = [];
  const visitedSheets = new Set<CSSStyleSheet>();
  function traverse(list: CSSRuleList, contexts: RuleContext[]): void {
    for (const rule of Array.from(list)) {
      if (rule.type === 1 && 'selectorText' in rule && 'style' in rule) {
        const styleRule = rule as CSSStyleRule;
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
            let matched = false;
            const matchSelector = selectorForStateMatching(selector);
            for (const node of nodes) {
              const element = elements.get(node.id);
              if (!element) continue;
              try {
                if (element.matches(matchSelector)) {
                  rules.push({ nodeId: node.id, originalSelector: selector, suffix: '', specificity: 0,
                    contexts, declarations, sourceOrder: order, preserveSelector: true });
                  matched = true;
                }
              } catch { skippedSelectors++; }
            }
            if (matched) preservedSelectors++;
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
        traverse(rule.cssRules, [...contexts, contextFor(rule)]);
      }
    }
  }
  let inaccessible = 0;
  function visitSheet(sheet: CSSStyleSheet, contexts: RuleContext[]): void {
    if (visitedSheets.has(sheet) || sheet.disabled) return;
    visitedSheets.add(sheet);
    const ruleCount = rules.length;
    const order = sourceOrder;
    const skipped = skippedSelectors;
    const preserved = preservedSelectors;
    try { traverse(sheet.cssRules, contexts); }
    catch {
      rules.length = ruleCount;
      sourceOrder = order;
      skippedSelectors = skipped;
      preservedSelectors = preserved;
      const href = sheet.href;
      const cssText = href ? fallbackStylesheets[href] : undefined;
      if (cssText) {
        try {
          const parsed = new CSSStyleSheet();
          parsed.replaceSync(cssText);
          if (cssText.trim() && !parsed.cssRules.length) throw new Error('No CSS rules parsed');
          traverse(parsed.cssRules, contexts);
          recoveredStylesheets++;
          if (/@import\b/i.test(cssText)) warnings.push('補完したCSSの @import は読み込めない場合があります。');
          return;
        } catch {
          rules.length = ruleCount;
          sourceOrder = order;
        }
      }
      inaccessible++;
      if (href) unreadableStylesheets.push(href);
    }
  }
  const ownerDocument = options.mode === 'selected' ? (selected as Element).ownerDocument : document;
  for (const sheet of Array.from(ownerDocument.styleSheets)) {
    if (sheet.disabled) continue;
    const media = sheet.media?.mediaText?.trim();
    const contexts: RuleContext[] = media && media !== 'all' ? [{ type: 'media', header: `@media ${media}` }] : [];
    visitSheet(sheet, contexts);
  }
  if (inaccessible) warnings.push(`${inaccessible} 件のスタイルシートを解析できませんでした（別オリジンまたは読み取りエラー）。`);
  if (preservedSelectors) warnings.push(`${preservedSelectors} 件の複雑なセレクタを元の形で出力しました。コンポーネントクラスへの統合対象外です。`);
  if (skippedSelectors) warnings.push(`${skippedSelectors} 件のセレクタは解析できず省略しました。`);
  const selectedLabel = nodes[0] ? `<${nodes[0].tagName} class="${nodes[0].classes.join(' ')}">` : '';
  return { nodes, rules, warnings, selectedLabel, originalHtml: options.mode === 'selected' ? (selected as Element).outerHTML.slice(0, 100_000) : '',
    unreadableStylesheets, recoveredStylesheets };
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
