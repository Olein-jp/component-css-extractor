import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateOutput, htmlReplacements, type GenerateOptions } from '../src/css/generate-css';
import { escapeCssIdentifier, isSimpleCompound, normalizeClasses, selectorClasses, selectorForStateMatching, splitSelectorList, stripSupportedSuffix } from '../src/css/selectors';
import { inspectPage, renderHtml } from '../src/inspector/inspect-page';
import { inspect, readStyleResources } from '../src/panel/chrome';
import { extractTopLevelImports } from '../src/css/imports';
import { varReferences } from '../src/css/custom-properties';
import { formatStylesheetDiagnostics, stylesheetLabel } from '../src/css/stylesheet-diagnostics';
import type { Declaration, ElementNode, PageSnapshot, RuleContext, SourceRule } from '../src/model/types';

describe('CSS import の抽出', () => {
  it('コメント・文字列・ネスト内のimportを取り違えず、URLとmediaを読む', () => {
    const source = '/* lead */ @import url("child.css") screen and (min-width: 700px); .foo { content: "@import fake.css;"; } @media all { @import "nested.css"; }';
    const result = extractTopLevelImports(source);
    expect(result.imports).toEqual([{
      marker: '.__component_css_import_marker_0__', href: 'child.css', media: 'screen and (min-width: 700px)', unsupported: false,
    }]);
    expect(result.cssText).toContain('.__component_css_import_marker_0__ { }');
    expect(result.cssText).toContain('content: "@import fake.css;"');
    expect(result.cssText).toContain('@import "nested.css"');
  });
});

describe('CSS カスタムプロパティの参照', () => {
  it('ネストしたフォールバックを読み、文字列とコメント内のvarは無視する', () => {
    expect(varReferences('calc(var(--gap, var(--default-gap, 1rem)) + 1px) "var(--quoted)" /* var(--comment) */'))
      .toEqual([{ name: '--gap', hasFallback: true }, { name: '--default-gap', hasFallback: true }]);
    expect(varReferences('var(--direct) var(--empty,)')).toEqual([
      { name: '--direct', hasFallback: false }, { name: '--empty', hasFallback: true },
    ]);
    expect(varReferences('var( /* gap */ --space , 1rem)')).toEqual([{ name: '--space', hasFallback: true }]);
  });
});

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
  it('外側のrootにしかない変数定義への依存を警告する', () => {
    const page = snapshot([node('0', ['sample'])], [rule('0', '.sample', 'padding', 'var(--space)', 0)]);
    const result = generateOutput(page, { ...options, rootClass: 'sample' });
    expect(result.css).toContain('padding: var(--space);');
    expect(result.warnings.join(' ')).toContain('フォールバックなし 1 件（--space）');
  });

  it('検査時に取得した変数をコンポーネントの先頭へまとめて補完する', () => {
    const page = { ...snapshot([node('0', ['sample'])], [
      rule('0', '.sample', 'padding', 'var(--space)', 0),
      rule('0', '.sample', 'color', 'var(--ink)', 1),
    ]), customPropertyValues: { '0': { '--space': 'var(--unit)', '--unit': '1rem', '--ink': '#123456' } } };
    const result = generateOutput(page, { ...options, rootClass: 'component' });
    expect(result.css).toMatch(/^\.component \{\n  --space: var\(--unit\);\n  --unit: 1rem;\n  --ink: #123456;\n\}\n\n\.component \{/);
    expect(result.warnings).toEqual([]);
    expect(result.recoveredCustomProperties).toBe(3);
  });

  it('出力内の定義は警告せず、設定で定義を省いたときは警告を再計算する', () => {
    const page = snapshot([node('0', ['sample'])], [
      rule('0', '.sample', '--space', '1rem', 0),
      rule('0', '.sample', 'padding', 'var(--space)', 1),
    ]);
    const enabled = generateOutput(page, options);
    expect(enabled.css).toContain('--space: 1rem;');
    expect(enabled.warnings).toEqual([]);
    const disabled = generateOutput(page, { ...options, includeCustomProperties: false });
    expect(disabled.css).not.toContain('--space: 1rem;');
    expect(disabled.warnings.join(' ')).toContain('フォールバックなし 1 件（--space）');
    expect(generateOutput(page, options).warnings).toEqual([]);
  });

  it('子要素だけの定義は親要素の参照を解決しない', () => {
    const page = snapshot([
      node('0', ['sample']), node('0.0', ['child'], 'span', '0'),
    ], [
      rule('0', '.sample', 'color', 'var(--ink)', 0),
      rule('0.0', '.child', '--ink', 'red', 1),
    ]);
    const result = generateOutput(page, options);
    expect(result.warnings.join(' ')).toContain('フォールバックなし 1 件（--ink）');
  });

  it('親要素の定義は子要素に継承されるものとして扱う', () => {
    const page = snapshot([
      node('0', ['sample']), node('0.0', ['child'], 'span', '0'),
    ], [
      rule('0', '.sample', '--ink', 'red', 0),
      rule('0.0', '.child', 'color', 'var(--ink)', 1),
    ]);
    expect(generateOutput(page, options).warnings).toEqual([]);
  });

  it('フォールバックがある未定義変数と直接依存を区別し、対象外のルールは数えない', () => {
    const page = snapshot([node('0', ['sample'])], [
      rule('0', '.sample', 'padding', 'var(--space, 1rem)', 0),
      rule('0', '.sample', 'color', 'var(--ink)', 1),
      rule('0', '.sample', 'border-color', 'var(--excluded)', 2, [{ type: 'media', header: '@media print' }]),
    ]);
    const result = generateOutput(page, { ...options, includeMedia: false });
    expect(result.warnings.join(' ')).toContain('フォールバックなし 1 件（--ink）');
    expect(result.warnings.join(' ')).toContain('フォールバックあり 1 件（--space）');
    expect(result.warnings.join(' ')).not.toContain('--excluded');
  });

  it('選択範囲外の単純な親条件をルートへ変換し、HTMLとCSSを単体で使えるようにする', () => {
    const page = snapshot([node('0', ['sample', 'external-pad'])], [
      rule('0', '.external-pad', 'padding', '1rem', 0),
      rule('0', '.external-pad', 'padding', '2rem', 1, [{ type: 'media', header: '@media (min-width: 700px)' }]),
      { ...rule('0', '.wrapper > .sample[data-state="ready"]', 'color', 'rgb(23, 101, 204)', 2),
        preserveSelector: true, externalDependency: true },
    ]);
    const output = generateOutput(page, { ...options, rootClass: 'component-test' });
    expect(output.css).toContain('.component-test[data-state="ready"] {\n  color: rgb(23, 101, 204);\n}');
    expect(output.css).toContain('@media (min-width: 700px) {\n  .component-test {\n    padding: 2rem;\n  }\n}');
    expect(output.css).not.toContain('.wrapper');
    expect(output.warnings).toEqual([]);
    const clone = {
      classList: ['sample', 'external-pad'], children: { item: () => null },
      setAttribute(_name: string, value: string) { this.classList = value.split(' '); },
      get outerHTML() { return `<div class="${this.classList.join(' ')}" data-state="ready">この要素を選択して解析</div>`; },
    };
    const selected = { nodeType: 1, cloneNode: () => clone } as unknown as Element;
    expect(renderHtml(htmlReplacements(page, output.nodes), selected))
      .toBe('<div class="component-test" data-state="ready">この要素を選択して解析</div>');
  });

  it('安全に変換できない祖先状態は保持して具体的に警告する', () => {
    const page = snapshot([node('0', ['sample'])], [
      { ...rule('0', '.theme:hover .sample', 'color', 'red', 0), preserveSelector: true, externalDependency: true },
    ]);
    const output = generateOutput(page, { ...options, rootClass: 'component-test' });
    expect(output.css).toContain('.theme:hover .sample {');
    expect(output.css).not.toContain('.component-test {');
    expect(output.warnings.join(' ')).toContain('.theme:hover .sample');
    expect(output.warnings.join(' ')).toContain('コピーしたHTMLだけでは');
    expect(htmlReplacements(page, output.nodes)[0].removeClasses).toEqual([]);
  });

  it('クラス属性を参照する条件は変換せず、元クラスと警告を保持する', () => {
    const selector = '.wrapper > .sample[class~="sample"]';
    const page = snapshot([node('0', ['sample'])], [
      { ...rule('0', selector, 'color', 'red', 0), preserveSelector: true, externalDependency: true },
    ]);
    const output = generateOutput(page, { ...options, rootClass: 'component-test' });
    expect(output.css).toContain(`${selector} {`);
    expect(output.warnings.join(' ')).toContain(selector);
    expect(htmlReplacements(page, output.nodes)[0].removeClasses).toEqual([]);
  });

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

  it('レイヤーの初出順を宣言し、importantでも同じ順序を保持する', () => {
    const second: RuleContext[] = [{ type: 'layer', header: '@layer second' }];
    const first: RuleContext[] = [{ type: 'layer', header: '@layer first' }];
    const page = { ...snapshot([node('0', ['target'])], [
      rule('0', '.target', 'color', 'blue', 0, second, true),
      rule('0', '.target', 'color', 'red', 1, first, true),
    ]), layerOrder: ['first', 'second'] };
    const result = generateOutput(page, options);
    expect(result.css).toMatch(/^@layer first, second;/);
    expect(result.css).toContain('@layer second {\n  .card {\n    color: blue !important;');
    expect(result.css).toContain('@layer first {\n  .card {\n    color: red !important;');
    expect(result.warnings).toEqual([]);

    const withoutLayers = generateOutput(page, { ...options, includeLayer: false });
    expect(withoutLayers.css).not.toContain('@layer');
  });

  it('匿名レイヤーの順序を再構成できない場合は警告する', () => {
    const page = { ...snapshot([node('0', ['target'])], [
      rule('0', '.target', 'color', 'red', 0, [{ type: 'layer', header: '@layer' }]),
    ]), layerOrderUncertain: true };
    const result = generateOutput(page, options);
    expect(result.warnings.join(' ')).toContain('レイヤーの優先順位が変わる場合があります');
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
    expect(selectorForStateMatching('.parent:hover .foo::before')).toBe('.parent .foo');
  });

  it('関数内のカンマではセレクタを分割しない', () => {
    expect(splitSelectorList('.foo:is(.a,.b), .bar')).toEqual(['.foo:is(.a,.b)', '.bar']);
    expect(normalizeClasses('.p-4 .bold,md:p-8')).toEqual(['p-4', 'bold', 'md:p-8']);
  });
});

describe('CSSOM収集', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('複数シートをまたぐレイヤーの初出順と対象ルールを収集する', () => {
    const style = (value: string, important = '') => ({ type: 1, cssText: `.target { color: ${value}; }`, selectorText: '.target',
      style: { length: 1, item: () => 'color', getPropertyValue: () => value, getPropertyPriority: () => important } });
    const sheets = [
      { disabled: false, cssRules: [
        { type: 0, cssText: '@layer first, second;' },
        { type: 0, cssText: '@layer second { .target { color: blue !important; } }', cssRules: [style('blue', 'important')] },
      ] },
      { disabled: false, cssRules: [
        { type: 0, cssText: '@layer first { .target { color: red !important; } }', cssRules: [style('red', 'important')] },
      ] },
    ];
    vi.stubGlobal('document', { styleSheets: sheets });
    const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['target'] }, null);
    expect(page.layerOrder).toEqual(['first', 'second']);
    expect(generateOutput(page, options).css).toMatch(/^@layer first, second;/);
  });

  it('実DOMでは一致するが選択範囲の複製では一致しない親条件を検出する', () => {
    const selector = '.wrapper > .sample[data-state="ready"]';
    const styleRule = { type: 1, selectorText: selector,
      style: { length: 1, item: () => 'color', getPropertyValue: () => 'rgb(23, 101, 204)', getPropertyPriority: () => '' } };
    const ownerDocument = { styleSheets: [{ disabled: false, cssRules: [styleRule] }] };
    const selected = { nodeType: 1, tagName: 'DIV', classList: ['sample', 'external-pad'],
      attributes: [{ name: 'class', value: 'sample external-pad' }, { name: 'data-state', value: 'ready' }],
      children: [], ownerDocument, outerHTML: '<div class="sample external-pad" data-state="ready"></div>',
      matches: (value: string) => value === selector,
      cloneNode: () => ({ matches: () => false }),
    } as unknown as Element;
    const page = inspectPage({ mode: 'selected', includeDescendants: false, manualClasses: [] }, selected);
    expect(page.rules).toHaveLength(1);
    expect(page.rules[0].externalDependency).toBe(true);
    const output = generateOutput(page, { ...options, rootClass: 'component-test' });
    expect(output.css).toContain('.component-test[data-state="ready"] {');
    expect(output.css).not.toContain('.wrapper');
    expect(output.warnings).toEqual([]);
  });

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
    expect(result.stylesheetDiagnostics).toEqual([{ reason: 'cssom-failed', label: 'URLのないスタイルシート' }]);
  });

  it('読み取れないシートをCSS本文で補完し、元のシート順を保つ', () => {
    class FakeStyleRule {
      type = 1;
      style: { length: number; item: () => string; getPropertyValue: () => string; getPropertyPriority: () => string };
      constructor(public selectorText: string, value: string) {
        this.style = { length: 1, item: () => 'color', getPropertyValue: () => value, getPropertyPriority: () => '' };
      }
    }
    class FakeSheet {
      cssRules: FakeStyleRule[] = [];
      replaceSync(text: string): void { this.cssRules = [new FakeStyleRule('.foo', text.includes('blue') ? 'blue' : 'unknown')]; }
    }
    const url = 'https://cdn.example.test/site.css';
    const sheets = [
      { disabled: false, cssRules: [new FakeStyleRule('.foo', 'red')] },
      { disabled: false, href: url, get cssRules(): never { throw new Error('SecurityError'); } },
      { disabled: false, cssRules: [new FakeStyleRule('.foo', 'green')] },
    ];
    vi.stubGlobal('document', { styleSheets: sheets });
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null, { [url]: '.foo { color: blue; }' });
    expect(page.rules.map((item) => item.declarations[0].value)).toEqual(['red', 'blue', 'green']);
    expect(page.recoveredStylesheets).toBe(1);
    expect(page.unreadableStylesheets).toEqual([]);
    expect(page.warnings).toEqual([]);
  });

  it('補完したCSSのimport先を元の位置とmedia条件で解析する', () => {
    class FakeStyleRule {
      type = 1;
      style: { length: number; item: () => string; getPropertyValue: () => string; getPropertyPriority: () => string };
      constructor(public selectorText: string, value: string) {
        this.style = { length: value ? 1 : 0, item: () => 'color', getPropertyValue: () => value, getPropertyPriority: () => '' };
      }
    }
    class FakeSheet {
      cssRules: FakeStyleRule[] = [];
      replaceSync(text: string): void {
        this.cssRules = [...text.matchAll(/(\.__component_css_import_marker_\d+__|\.foo)\s*\{\s*(?:color:\s*([^;}]+);?)?\s*\}/g)]
          .map((match) => new FakeStyleRule(match[1], match[2]?.trim() ?? ''));
      }
    }
    const root = 'https://cdn.example.test/css/main.css';
    const child = 'https://cdn.example.test/css/child.css';
    vi.stubGlobal('document', { styleSheets: [{ disabled: false, href: root, get cssRules(): never { throw new Error('SecurityError'); } }] });
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null, {
      [root]: '.foo { color: red; } @import "child.css" screen and (min-width: 700px); .foo { color: green; }',
      [child]: '.foo { color: blue; }',
    });
    // Imports after a style rule are invalid CSS and must not be promoted into effective rules.
    expect(page.rules.map((rule) => rule.declarations[0].value)).toEqual(['red', 'green']);
    const valid = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null, {
      [root]: '@import "child.css" screen and (min-width: 700px); .foo { color: green; }',
      [child]: '.foo { color: blue; }',
    });
    expect(valid.rules.map((rule) => rule.declarations[0].value)).toEqual(['blue', 'green']);
    expect(valid.rules[0].contexts).toEqual([{ type: 'media', header: '@media screen and (min-width: 700px)' }]);
    expect(valid.rules.map((rule) => rule.sourceOrder)).toEqual([0, 1]);
    expect(valid.recoveredStylesheets).toBe(2);
    expect(valid.warnings).toEqual([]);
  });

  it('通常のCSSOMで読めるimport先は従来どおり解析する', () => {
    const style = { length: 1, item: () => 'color', getPropertyValue: () => 'blue', getPropertyPriority: () => '' };
    const child = { disabled: false, cssRules: [{ type: 1, selectorText: '.foo', style }] };
    const imported = { type: 3, styleSheet: child, media: { mediaText: '(min-width: 700px)' } };
    vi.stubGlobal('document', { styleSheets: [{ disabled: false, cssRules: [imported] }] });
    const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null);
    expect(page.rules).toHaveLength(1);
    expect(page.rules[0].contexts).toEqual([{ type: 'media', header: '@media (min-width: 700px)' }]);
    expect(page.recoveredStylesheets).toBe(0);
    expect(page.warnings).toEqual([]);
  });

  it('取得できないimport、未対応条件、循環参照を警告する', () => {
    class FakeSheet {
      cssRules: Array<{ type: number; selectorText: string; style: { length: number } }> = [];
      replaceSync(text: string): void {
        this.cssRules = [...text.matchAll(/(\.__component_css_import_marker_\d+__)\s*\{\s*\}/g)]
          .map((match) => ({ type: 1, selectorText: match[1], style: { length: 0 } }));
      }
    }
    const root = 'https://cdn.example.test/main.css';
    const child = 'https://cdn.example.test/child.css';
    vi.stubGlobal('document', { styleSheets: [{ disabled: false, href: root, get cssRules(): never { throw new Error('SecurityError'); } }] });
    vi.stubGlobal('CSSStyleSheet', FakeSheet);
    const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null, {
      [root]: '@import "child.css"; @import "missing.css"; @import "layer.css" layer(foo);',
      [child]: '@import "main.css";',
    });
    expect(page.warnings).toContain('1 件の @import 先を補完できませんでした。');
    expect(page.warnings).toContain('1 件の @import は layer・supports 条件または URL の形式に対応していないため省略しました。');
    expect(page.warnings).toContain('1 件の循環する @import を省略しました。');
  });

  it('一致する複雑なセレクタを元の形で保ち、HTMLに必要なクラスを残す', () => {
    class FakeStyleRule {
      type = 1;
      style = { length: 1, item: () => 'color', getPropertyValue: () => 'red', getPropertyPriority: () => '' };
      constructor(public selectorText: string) {}
    }
    const rules = [new FakeStyleRule('.parent:hover .foo'), new FakeStyleRule('.foo:not(.disabled)')];
    const ownerDocument = { styleSheets: [{ disabled: false, cssRules: rules }] };
    const selected = { nodeType: 1, tagName: 'DIV', classList: ['foo'], attributes: [], children: [], ownerDocument, outerHTML: '<div class="foo"></div>',
      matches: (selector: string) => selector === '.parent .foo' || selector === '.foo:not(.disabled)',
      cloneNode: () => ({ matches: (selector: string) => selector === '.foo:not(.disabled)' }) } as unknown as Element;
    const page = inspectPage({ mode: 'selected', includeDescendants: false, manualClasses: [] }, selected);
    expect(page.rules).toHaveLength(2);
    expect(page.rules.every((item) => item.preserveSelector)).toBe(true);
    expect(page.rules.map((item) => item.externalDependency)).toEqual([true, false]);
    const output = generateOutput(page, options);
    expect(output.css).toContain('.parent:hover .foo {');
    expect(output.css).toContain('.foo:not(.disabled) {');
    expect(output.warnings.join(' ')).toContain('.parent:hover .foo');
    expect(htmlReplacements(page, output.nodes)).toEqual([{ id: '0', outputClass: 'card', removeClasses: [] }]);
  });

  it('親クラスだけを参照するルールも子孫ノードのCSSとして保持する', () => {
    class FakeStyleRule {
      type = 1;
      selectorText = '.foo > span';
      style = { length: 1, item: () => 'color', getPropertyValue: () => 'red', getPropertyPriority: () => '' };
    }
    const ownerDocument = { styleSheets: [{ disabled: false, cssRules: [new FakeStyleRule()] }] };
    const child = { nodeType: 1, tagName: 'SPAN', classList: [], attributes: [], children: [], ownerDocument,
      matches: (selector: string) => selector === '.foo > span' } as unknown as Element;
    const selected = { nodeType: 1, tagName: 'DIV', classList: ['foo'], attributes: [], children: [child], ownerDocument,
      outerHTML: '<div class="foo"><span></span></div>', matches: () => false } as unknown as Element;
    const page = inspectPage({ mode: 'selected', includeDescendants: true, manualClasses: [] }, selected);
    expect(page.rules).toHaveLength(1);
    expect(page.rules[0].nodeId).toBe('0.0');
    expect(page.rules[0].preserveSelector).toBe(true);
  });
});

describe('DevTools Resource API', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('CSS本文とbase64本文を取得して復号する', async () => {
    const urls = ['https://example.test/plain.css', 'https://example.test/encoded.css', 'https://example.test/object.css'];
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { getResources: (callback: (resources: unknown[]) => void) => callback([
      { url: urls[0], getContent: (done: (content: string, encoding: string) => void) => done('.foo { color: red; }', '') },
      { url: urls[1], getContent: (done: (content: string, encoding: string) => void) => done(btoa('.bar { color: blue; }'), 'base64') },
      { url: urls[2], getContent: (done: (response: { content: string; encoding: string }) => void) => done({ content: '.baz { color: green; }', encoding: '' }) },
    ]) } } });
    const result = await readStyleResources(urls);
    expect(result.stylesheets[urls[0]]).toBe('.foo { color: red; }');
    expect(result.stylesheets[urls[1]]).toBe('.bar { color: blue; }');
    expect(result.stylesheets[urls[2]]).toBe('.baz { color: green; }');
    expect(result.diagnostics).toEqual([]);
  });

  it('import先を相対URLでたどり、循環時も同じリソースを一度だけ読む', async () => {
    const root = 'https://example.test/css/main.css';
    const child = 'https://example.test/css/child.css';
    const reads: string[] = [];
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { getResources: (callback: (resources: unknown[]) => void) => callback([
      { url: root, getContent: (done: (content: string, encoding: string) => void) => { reads.push(root); done('@import "child.css"; .foo { color: red; }', ''); } },
      { url: child, getContent: (done: (content: string, encoding: string) => void) => { reads.push(child); done('@import "main.css"; .foo { color: blue; }', ''); } },
    ]) } } });
    const result = await readStyleResources([root]);
    expect(Object.keys(result.stylesheets)).toEqual([root, child]);
    expect(reads).toEqual([root, child]);
    expect(result.diagnostics).toEqual([]);
  });

  it('import先にも既存の容量上限を適用する', async () => {
    const root = 'https://example.test/main.css';
    const child = 'https://example.test/large.css';
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { getResources: (callback: (resources: unknown[]) => void) => callback([
      { url: root, getContent: (done: (content: string, encoding: string) => void) => done('@import "large.css";', '') },
      { url: child, getContent: (done: (content: string, encoding: string) => void) => done('a'.repeat(8_000_001), '') },
    ]) } } });
    const result = await readStyleResources([root]);
    expect(Object.keys(result.stylesheets)).toEqual([root]);
    expect(result.diagnostics).toEqual([{ reason: 'size-limit', label: 'example.test/large.css' }]);
  });

  it('リソースなしと本文取得失敗を区別し、URLの機密部分を表示しない', async () => {
    const missing = 'https://user:password@cdn.example.test/missing.css?token=secret#private';
    const failed = 'https://cdn.example.test/failed.css?key=hidden';
    vi.stubGlobal('chrome', { devtools: { inspectedWindow: { getResources: (callback: (resources: unknown[]) => void) => callback([
      { url: failed, getContent: (done: (content: string | undefined, encoding: string) => void) => done(undefined, '') },
    ]) } } });
    const result = await readStyleResources([missing, failed]);
    expect(result.diagnostics).toEqual([
      { reason: 'resource-missing', label: 'cdn.example.test/missing.css' },
      { reason: 'content-failed', label: 'cdn.example.test/failed.css' },
    ]);
    expect(JSON.stringify(result.diagnostics)).not.toMatch(/password|secret|private|hidden/);
  });

  it('読み取れないURLがある場合だけ再取得して再解析する', async () => {
    const url = 'https://cdn.example.test/site.css';
    const first: PageSnapshot = { nodes: [node('0', ['foo'])], rules: [], warnings: [],
      selectedLabel: '', originalHtml: '', unreadableStylesheets: [url], recoveredStylesheets: 0 };
    const second: PageSnapshot = { ...first, warnings: [], unreadableStylesheets: [], recoveredStylesheets: 1 };
    const expressions: string[] = [];
    vi.stubGlobal('fetch', async () => ({ ok: true, text: async () => 'var __componentCssInspector = {};' }));
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://test/inspect-page.js' }, devtools: { inspectedWindow: {
      eval: (expression: string, callback: (value: PageSnapshot, error: null) => void) => {
        expressions.push(expression);
        callback(expressions.length === 1 ? first : second, null);
      },
      getResources: (callback: (resources: unknown[]) => void) => callback([{ url, getContent: (done: (content: string, encoding: string) => void) => done('.foo { color: blue; }', '') }]),
    } } });
    const result = await inspect({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] });
    expect(expressions).toHaveLength(2);
    expect(expressions[1]).toContain('.foo { color: blue; }');
    expect(result.recoveredStylesheets).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  it('補完成功と取得不能が混在しても未解析分だけを警告する', async () => {
    const good = 'https://cdn.example.test/good.css';
    const missing = 'https://user:password@cdn.example.test/missing.css?token=secret';
    const first: PageSnapshot = { nodes: [node('0', ['foo'])], rules: [], warnings: [], selectedLabel: '', originalHtml: '',
      unreadableStylesheets: [good, missing], recoveredStylesheets: 0 };
    const second: PageSnapshot = { ...first, unreadableStylesheets: [missing], recoveredStylesheets: 1 };
    let calls = 0;
    vi.stubGlobal('chrome', { runtime: { getURL: () => 'chrome-extension://test/inspect-page.js' }, devtools: { inspectedWindow: {
      eval: (_expression: string, callback: (value: PageSnapshot, error: null) => void) => callback(++calls === 1 ? first : second, null),
      getResources: (callback: (resources: unknown[]) => void) => callback([
        { url: good, getContent: (done: (content: string, encoding: string) => void) => done('.foo { color: blue; }', '') },
      ]),
    } } });
    const result = await inspect({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] });
    expect(result.recoveredStylesheets).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('DevToolsにリソースがありません');
    expect(result.warnings[0]).toContain('cdn.example.test/missing.css');
    expect(result.warnings.join(' ')).not.toMatch(/good\.css|password|secret/);
  });
});

describe('スタイルシート診断', () => {
  it('取得したCSSの解析失敗をリソース取得失敗と区別する', () => {
    const url = 'https://cdn.example.test/broken.css?token=secret';
    class BrokenSheet { replaceSync(): never { throw new Error('ParseError'); } }
    vi.stubGlobal('document', { styleSheets: [{ disabled: false, href: url, get cssRules(): never { throw new Error('SecurityError'); } }] });
    vi.stubGlobal('CSSStyleSheet', BrokenSheet);
    try {
      const page = inspectPage({ mode: 'manual', includeDescendants: false, manualClasses: ['foo'] }, null, { [url]: 'invalid' });
      expect(page.stylesheetDiagnostics).toEqual([{ reason: 'parse-failed', label: 'cdn.example.test/broken.css' }]);
      expect(page.warnings.join(' ')).not.toContain('token=secret');
    } finally { vi.unstubAllGlobals(); }
  });

  it('警告の対象は代表例3件までに収める', () => {
    const diagnostics = ['a.css', 'b.css', 'c.css', 'd.css'].map((name) =>
      ({ reason: 'resource-missing' as const, label: stylesheetLabel(`https://cdn.example.test/${name}`) }));
    const warnings = formatStylesheetDiagnostics(diagnostics);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('4 件');
    expect(warnings[0]).toContain('a.css');
    expect(warnings[0]).not.toContain('d.css');
  });

  it('data URLのCSS本文は診断表示に含めない', () => {
    expect(stylesheetLabel('data:text/css,.secret%7Bcolor:red%7D')).toBe('data形式のスタイルシート');
  });
});
