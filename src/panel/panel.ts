import { generateOutput, type GenerateOptions, type Strategy } from '../css/generate-css';
import { normalizeClasses, selectorClasses } from '../css/selectors';
import { inspect, readSelection, renderHtml } from './chrome';
import type { AnalyzeOptions } from '../model/types';

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element: ${id}`);
  return element as T;
}

const selection = required<HTMLParagraphElement>('selection');
const rootClass = required<HTMLInputElement>('root-class');
const manualWrap = required<HTMLLabelElement>('manual-wrap');
const manualClasses = required<HTMLTextAreaElement>('manual-classes');
const scopeFieldset = required<HTMLFieldSetElement>('scope-fieldset');
const status = required<HTMLParagraphElement>('status');
const cssOutput = required<HTMLElement>('css-output');
const htmlOutput = required<HTMLElement>('html-output');
const warnings = required<HTMLDivElement>('warnings');
const analyzeButton = required<HTMLButtonElement>('analyze');
const copyCss = required<HTMLButtonElement>('copy-css');
const copyHtml = required<HTMLButtonElement>('copy-html');
const copyBoth = required<HTMLButtonElement>('copy-both');
let rootEdited = false;
let requestVersion = 0;

function radioValue(name: string): string {
  return (document.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`))?.value ?? '';
}

function checked(id: string): boolean { return required<HTMLInputElement>(id).checked; }

function setMode(): void {
  const manual = radioValue('mode') === 'manual';
  manualWrap.classList.toggle('hidden', !manual);
  scopeFieldset.disabled = manual;
  selection.classList.toggle('hidden', manual);
  if (manual && !rootEdited) rootClass.value = 'component';
}

async function refreshSelection(): Promise<void> {
  const version = ++requestVersion;
  try {
    const current = await readSelection();
    if (version !== requestVersion) return;
    selection.textContent = current ? `<${current.tagName} class="${current.classes.join(' ')}">` : 'Elementsパネルで要素を選択してください。';
    if (current && !rootEdited) rootClass.value = current.classes[0] ?? 'component';
  } catch (error) {
    selection.textContent = error instanceof Error ? error.message : '選択要素を取得できませんでした。';
  }
}

function readOptions(): { analyze: AnalyzeOptions; generate: GenerateOptions } {
  const mode = radioValue('mode') === 'manual' ? 'manual' : 'selected';
  const rawRoot = rootClass.value.trim().replace(/^\./, '');
  if (!rawRoot || /[\s.#>+~\[\],{}]/.test(rawRoot)) throw new Error('ルートのクラス名を1つ入力してください。');
  const classes = normalizeClasses(manualClasses.value);
  if (mode === 'manual' && !classes.length) throw new Error('解析するクラス名を入力してください。');
  if (mode === 'manual' && classes.length > 200) throw new Error('クラス名は一度に200件まで入力できます。');
  return {
    analyze: { mode, includeDescendants: radioValue('scope') === 'descendants' && mode === 'selected', manualClasses: classes },
    generate: { rootClass: rawRoot, strategy: required<HTMLSelectElement>('strategy').value as Strategy,
      includeMedia: checked('media'), includePseudoClasses: checked('pseudo-classes'), includePseudoElements: checked('pseudo-elements'),
      includeSupports: checked('supports'), includeContainer: checked('container'), includeLayer: checked('layer'), includeCustomProperties: checked('custom-properties') },
  };
}

function showWarnings(messages: string[]): void {
  warnings.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('p');
    item.textContent = message;
    warnings.append(item);
  }
}

async function analyze(): Promise<void> {
  const version = ++requestVersion;
  analyzeButton.disabled = true;
  status.textContent = '解析中…';
  cssOutput.textContent = '';
  htmlOutput.textContent = '';
  copyCss.disabled = true;
  copyHtml.disabled = true;
  copyBoth.disabled = true;
  showWarnings([]);
  try {
    const options = readOptions();
    const snapshot = await inspect(options.analyze);
    if (version !== requestVersion) return;
    if (!snapshot.nodes.length) throw new Error('Elementsパネルで要素を選択してください。');
    const result = generateOutput(snapshot, options.generate);
    if (options.analyze.mode === 'selected' && options.generate.strategy !== 'dom') {
      try {
        const replacements = result.nodes.filter((node) => node.outputClass && (node.id === '0' || snapshot.rules.some((rule) => rule.nodeId === node.id)))
          .map((node) => ({ id: node.id, outputClass: node.outputClass,
            removeClasses: [...new Set(snapshot.rules.filter((rule) => rule.nodeId === node.id).flatMap((rule) => selectorClasses(rule.originalSelector)))] }));
        result.html = await renderHtml(replacements, options.analyze.mode);
      }
      catch { result.warnings.push('変更後HTMLを生成できませんでした。'); }
    }
    if (version !== requestVersion) return;
    cssOutput.textContent = result.css;
    htmlOutput.textContent = result.html;
    showWarnings(result.warnings);
    copyCss.disabled = !result.css;
    copyHtml.disabled = !result.html;
    copyBoth.disabled = !result.css && !result.html;
    status.textContent = result.css ? `${result.nodes.length} 要素を解析しました。` : '一致するCSSがありません。';
  } catch (error) {
    if (version === requestVersion) {
      status.textContent = error instanceof Error ? error.message : '解析に失敗しました。';
      showWarnings([]);
    }
  } finally { analyzeButton.disabled = false; }
}

async function copy(value: string): Promise<void> {
  try { await navigator.clipboard.writeText(value); status.textContent = 'コピーしました。'; }
  catch { status.textContent = 'コピーできませんでした。ブラウザのクリップボード権限を確認してください。'; }
}

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((input) => input.addEventListener('change', setMode));
rootClass.addEventListener('input', () => { rootEdited = true; });
analyzeButton.addEventListener('click', () => { void analyze(); });
copyCss.addEventListener('click', () => { void copy(cssOutput.textContent ?? ''); });
copyHtml.addEventListener('click', () => { void copy(htmlOutput.textContent ?? ''); });
copyBoth.addEventListener('click', () => { void copy(`${htmlOutput.textContent ?? ''}\n\n${cssOutput.textContent ?? ''}`.trim()); });
chrome.devtools.panels.elements.onSelectionChanged.addListener(() => { void refreshSelection(); });
void refreshSelection();
