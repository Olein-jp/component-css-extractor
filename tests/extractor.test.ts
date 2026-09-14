import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateOutput, type GenerateOptions } from '../src/css/generate-css';
import { escapeCssIdentifier, isSimpleCompound, normalizeClasses, selectorClasses, splitSelectorList, stripSupportedSuffix } from '../src/css/selectors';
import { inspectPage } from '../src/inspector/inspect-page';
import type { Declaration, ElementNode, PageSnapshot, RuleContext, SourceRule } from '../src/model/types';

const options: GenerateOptions = {
  rootClass: 'card', strategy: 'generated', includeMedia: true, includePseudoClasses: true,
  includePseudoElements: true, includeSupports: true, includeContainer: true, includeLayer: true,
  includeCustomProperties: true,
};

function node(id: string, classes: string[], tagName = 'div', parentId: string | null = null): ElementNode {
  return { id, parentId, tagName, classes, attributes: {} };
}

function rule(nodeId: string, selector: string, property: string, value: string, order: number,
  contexts: RuleContext[] = [], important = false, suffix = '', specificity = 10): SourceRule {
  const declaration: Declaration = { property, value, important, sourceOrder: order };
  return { nodeId, originalSelector: selector, suffix, specificity, contexts, declarations: [declaration], sourceOrder: order };
}

function snapshot(nodes: ElementNode[], rules: SourceRule[]): PageSnapshot {
  return { nodes, rules, warnings: [], selectedLabel: '', originalHtml: '' };
}

describe('CSS生成', () => {
  it('複数のUtility classを1つのセレクタに統合する', () => {
    const result = generateOutput(snapshot([node('0', ['card', 'p-4', 'bold'])], [
      rule('0', '.p-4', 'padding', '1rem', 0), rule('0', '.bold', 'font-weight', '700', 1),
    ]), options);
    expect(result.css).toBe('.card {\n  padding: 1rem;\n  font-weight: 700;\n}');
  });

  it('viewportに依存せずmedia queryを保持する', () => {
    const media: RuleContext[] = [{ type: 'media', header: '@media (min-width: 768px)' }];
    const result = generateOutput(snapshot([node('0', ['card', 'p-4', 'md-padding'])], [
      rule('0', '.p-4', 'padding', '1rem', 0), rule('0', '.md-padding', 'padding', '2rem', 1, media),
    ]), options);
    expect(result.css).toBe('.card {\n  padding: 1rem;\n}\n\n@media (min-width: 768px) {\n  .card {\n    padding: 2rem;\n  }\n}');
  });

  it('子要素の宣言を親に混ぜずに出力する', () => {
    const result = generateOutput(snapshot([
      node('0', ['card', 'p-4']), node('0.0', ['large', 'bold'], 'h2', '0'),
    ], [rule('0', '.p-4', 'padding', '1rem', 0), rule('0.0', '.large', 'font-size', '2rem', 1),
      rule('0.0', '.bold', 'font-weight', '700', 2)]), options);
    expect(result.css).toContain('.card {\n  padding: 1rem;\n}');
    expect(result.css).toContain('.card__title {\n  font-size: 2rem;\n  font-weight: 700;\n}');
    expect(result.css).not.toContain('.card {\n  padding: 1rem;\n  font-size');
  });

  it('importantとspecificityを優先して競合を解決する', () => {
    const result = generateOutput(snapshot([node('0', ['foo', 'bar'])], [
      rule('0', '.foo', 'color', 'red', 0, [], true),
      rule('0', '.bar', 'color', 'blue', 1),
      rule('0', '.foo.bar', 'background', 'green', 2, [], false, '', 20),
    ]), options);
    expect(result.css).toContain('color: red !important;');
    expect(result.css).not.toContain('color: blue;');
    expect(result.css).toContain('background: green;');
  });

  it('疑似クラスとグループルールの文脈を保持する', () => {
    const contexts: RuleContext[] = [{ type: 'supports', header: '@supports (display: grid)' }, { type: 'container', header: '@container (min-width: 500px)' }];
    const result = generateOutput(snapshot([node('0', ['foo'])], [
      rule('0', '.foo:hover', 'color', 'red', 0, [], false, ':hover'),
      rule('0', '.foo', 'display', 'grid', 1, contexts),
    ]), options);
    expect(result.css).toContain('.card:hover {\n  color: red;\n}');
    expect(result.css).toContain('@supports (display: grid) {\n  @container (min-width: 500px) {');
  });

  it('文脈が間に入る宣言を順序を崩して統合しない', () => {
    const media: RuleContext[] = [{ type: 'media', header: '@media (min-width: 1px)' }];
    const result = generateOutput(snapshot([node('0', ['foo'])], [
      rule('0', '.foo', 'color', 'red', 0), rule('0', '.foo', 'color', 'blue', 1, media), rule('0', '.foo', 'color', 'green', 2),
    ]), options);
    expect(result.css.indexOf('color: red')).toBeLessThan(result.css.indexOf('color: blue'));
    expect(result.css.indexOf('color: blue')).toBeLessThan(result.css.indexOf('color: green'));
  });
});

describe('セレクタ解析', () => {
  it('エスケープされたUtility classを扱う', () => {
    expect(selectorClasses('.md\\:p-8:hover')).toEqual(['md:p-8']);
    expect(stripSupportedSuffix('.md\\:p-8:hover')).toEqual({ base: '.md\\:p-8', suffix: ':hover' });
    expect(selectorClasses('.\\32 xl\\:grid')).toEqual(['2xl:grid']);
    expect(isSimpleCompound('.\\32 xl\\:grid')).toBe(true);
    expect(escapeCssIdentifier('2xl:grid')).toBe('\\32 xl\\3a grid');
  });

  it('関数内のカンマではセレクタを分割しない', () => {
    expect(splitSelectorList('.foo:is(.a,.b), .bar')).toEqual(['.foo:is(.a,.b)', '.bar']);
    expect(normalizeClasses('.p-4 .bold,md:p-8')).toEqual(['p-4', 'bold', 'md:p-8']);
  });
});

describe('CSSOM収集', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('選択要素と子孫を別ノードとして収集し、受け入れ例のCSSを生成する', () => {
    class FakeStyleRule {
      type = 1;
      style: { length: number; item: () => string; getPropertyValue: () => string; getPropertyPriority: () => string };
      constructor(public selectorText: string, property: string, value: string) {
        this.style = { length: 1, item: () => property, getPropertyValue: () => value, getPropertyPriority: () => '' };
      }
    }
    const styleRules = [
      new FakeStyleRule('.p-6', 'padding', '1.5rem'),
      new FakeStyleRule('.bg-white', 'background-color', '#fff'),
      new FakeStyleRule('.text-xl', 'font-size', '1.25rem'),
      new FakeStyleRule('.font-bold', 'font-weight', '700'),
      { type: 4, cssText: '@media (min-width: 600px) { .font-bold { font-weight: 800; } }',
        cssRules: [new FakeStyleRule('.font-bold', 'font-weight', '800')] },
    ];
    const ownerDocument = { styleSheets: [{ disabled: false, cssRules: styleRules }] };
    function element(tagName: string, classes: string[], children: unknown[] = []): Element {
      return { nodeType: 1, tagName, classList: classes, attributes: [{ name: 'class', value: classes.join(' ') }],
        children, ownerDocument, outerHTML: `<${tagName.toLowerCase()} class="${classes.join(' ')}"></${tagName.toLowerCase()}>`,
        matches: (selector: string) => selectorClasses(selector).every((name) => classes.includes(name)) } as unknown as Element;
    }
    const selected = element('DIV', ['card', 'p-6', 'bg-white'], [element('H2', ['text-xl', 'font-bold'])]);
    vi.stubGlobal('CSSStyleRule', FakeStyleRule);
    const page = inspectPage({ mode: 'selected', includeDescendants: true, manualClasses: [] }, selected);
    expect(page.nodes.map((item) => item.id)).toEqual(['0', '0.0']);
    const output = generateOutput(page, options);
    expect(output.css).toContain('.card {\n  padding: 1.5rem;\n  background-color: #fff;\n}');
    expect(output.css).toContain('.card__title {\n  font-size: 1.25rem;\n  font-weight: 700;\n}');
    expect(output.css).toContain('@media (min-width: 600px) {\n  .card__title {\n    font-weight: 800;\n  }\n}');
  });

  it('壊れたシートを飛ばして他のシートとmedia ruleを解析する', () => {
    class FakeStyleRule {
      type = 1;
      selectorText: string;
      style: { length: number; item: (index: number) => string; getPropertyValue: (name: string) => string; getPropertyPriority: () => string };
      constructor(selector: string, property: string, value: string, priority = '') {
        this.selectorText = selector;
        this.style = { length: 1, item: () => property, getPropertyValue: () => value, getPropertyPriority: () => priority };
      }
    }
    const broken = { disabled: false, get cssRules(): never { throw new Error('SecurityError'); } };
    const normal = { disabled: false, cssRules: [new FakeStyleRule('.p-4', 'padding', '1rem')] };
    const media = { disabled: false, cssRules: [{ cssText: '@media (min-width: 768px) { .md\\:p-8 { padding: 2rem; } }', cssRules: [new FakeStyleRule('.md\\:p-8', 'padding', '2rem')] }] };
    vi.stubGlobal('CSSStyleRule', FakeStyleRule);
    vi.stubGlobal('document', { styleSheets: [broken, normal, media] });
    const result = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['p-4', 'md:p-8'] }, null);
    expect(result.rules).toHaveLength(2);
    expect(result.rules[1].contexts).toEqual([{ type: 'media', header: '@media (min-width: 768px)' }]);
    expect(result.warnings).toContain('1 件のスタイルシートを解析できませんでした（別オリジンまたは読み取りエラー）。');
  });
});
