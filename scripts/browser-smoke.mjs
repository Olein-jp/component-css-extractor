import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const fixtureTitle = 'Component CSS Extractor 機能テスト';
const cascadeTitle = 'CSS Cascade 調査用ページ';
const externalTitle = 'Component CSS Extractor 外部 CSS 自動テスト';
const missingUrl = 'https://example.invalid/component-css-extractor-missing.css';
const servers = [];
let browser;

async function chromeExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; }
    catch { /* 次の標準パスを確認します。 */ }
  }
  throw new Error('Google Chrome が見つかりません。CHROME_BIN に実行ファイルのパスを指定してください。');
}

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolveReady, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveReady);
  });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function evalInspected(frame, expression) {
  return frame.evaluate((code) => new Promise((resolveResult, reject) => {
    chrome.devtools.inspectedWindow.eval(code, (value, exception) => {
      if (exception?.isError || exception?.isException) reject(new Error(exception.description || exception.value));
      else resolveResult(value);
    });
  }), expression);
}

async function waitFor(check, label, timeout = 10000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`タイムアウト: ${label}`);
}

async function select(frame, selector) {
  await evalInspected(frame, `inspect(document.querySelector(${JSON.stringify(selector)}))`);
  await waitFor(() => evalInspected(frame, '$0?.getAttribute("data-test-target")').then((value) => value === selector.match(/data-test-target="([^"]+)/)?.[1]), `Elements の選択: ${selector}`);
}

async function setValue(frame, selector, value) {
  await frame.$eval(selector, (element, next) => {
    element.value = next;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function analyze(frame) {
  await frame.$eval('#analyze', (button) => button.click());
  return waitFor(async () => {
    const result = await frame.evaluate(() => ({
      status: document.querySelector('#status').textContent,
      css: document.querySelector('#css-output').textContent,
      html: document.querySelector('#html-output').textContent,
      warnings: document.querySelector('#warnings').textContent,
    }));
    return result.status && result.status !== '解析中…' ? result : null;
  }, '解析結果');
}

try {
  browser = await puppeteer.launch({
    executablePath: await chromeExecutable(), headless: false, devtools: true, pipe: true, enableExtensions: [resolve('dist')],
    args: ['--no-first-run'],
  });
  const inspected = await browser.newPage();
  await inspected.goto(pathToFileURL(resolve('tests/feature-fixture.html')).href);
  await browser.waitForTarget((target) => target.url().endsWith('/devtools.html'));

  let frame;
  await waitFor(async () => {
    for (const target of browser.targets().filter((item) => item.url().startsWith('devtools://'))) {
      const frontend = await target.asPage();
      const candidate = frontend.frames().find((item) => item.url().endsWith('/devtools.html'));
      if (!candidate) continue;
      try {
        if (await evalInspected(candidate, 'document.title') === fixtureTitle) { frame = candidate; return true; }
      } catch { /* このフレームは DevTools の読み込み中の場合があります。 */ }
    }
    return false;
  }, '拡張の DevTools ページ');

  // 製品版のパネルとスクリプトを、拡張の実 DevTools コンテキストで実行します。
  // iframe では inspectedWindow API が動かないため、DevTools ページ本体へ読み込みます。
  await frame.evaluate(async () => {
    const response = await fetch(chrome.runtime.getURL('panel.html'));
    if (!response.ok) throw new Error('パネルを読み込めませんでした。');
    const markup = new DOMParser().parseFromString(await response.text(), 'text/html');
    document.body.replaceWith(document.importNode(markup.body, true));
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('panel.js');
    document.body.append(script);
  });
  await frame.waitForSelector('#analyze');

  await evalInspected(frame, `(() => {
    document.documentElement.style.setProperty('--fixture-space', '1rem');
    const style = document.createElement('style');
    style.textContent = '.fixture-var { padding: var(--fixture-space); }';
    document.head.append(style);
    document.querySelector('[data-test-target="complex"]').classList.add('fixture-var');
    return true;
  })()`);
  await select(frame, '[data-test-target="complex"]');
  await setValue(frame, '#root-class', 'component-test');
  const selected = await analyze(frame);
  assert.match(selected.status, /1 要素を解析しました/);
  assert.match(selected.html, /class="component-test" data-state="ready"/);
  assert.match(selected.css, /\.component-test\[data-state="ready"\] \{\s+color: rgb\(23, 101, 204\)/);
  assert.match(selected.css, /@media \(min-width: 700px\)/);
  assert.match(selected.css, /--fixture-space: 1rem/);
  assert.doesNotMatch(selected.css, /fixture-shell/);
  assert.equal(selected.warnings, '');
  console.log('✓ Elements で選択した要素を抽出');

  await frame.$eval('input[name="mode"][value="manual"]', (input) => input.click());
  await setValue(frame, '#manual-classes', 'manual-pad manual-strong');
  await setValue(frame, '#root-class', 'manual-result');
  const manual = await analyze(frame);
  assert.equal(manual.html, '');
  assert.match(manual.css, /\.manual-result \{/);
  assert.match(manual.css, /padding-top: 1rem/);
  assert.match(manual.css, /font-weight: 700/);
  assert.equal(manual.warnings, '');
  console.log('✓ 入力したクラスから抽出');

  await frame.$eval('input[name="mode"][value="selected"]', (input) => input.click());
  await select(frame, '[data-test-target="descendants"]');
  await frame.$eval('input[name="scope"][value="descendants"]', (input) => input.click());
  await setValue(frame, '#strategy', 'generated');
  await setValue(frame, '#root-class', 'card-demo');
  const descendants = await analyze(frame);
  assert.match(descendants.html, /class="card-demo"/);
  assert.match(descendants.html, /class="card-demo__title"/);
  assert.match(descendants.html, /class="card-demo__description"/);
  assert.match(descendants.css, /\.card-demo__title \{[\s\S]*font-weight: 700/);
  assert.match(descendants.css, /\.card-demo__description \{\s+color: rgb\(75, 85, 99\)/);
  assert.equal(descendants.warnings, '');
  console.log('✓ 子孫要素を含めた抽出');

  await inspected.goto(pathToFileURL(resolve('tests/cascade-investigation-fixture.html')).href);
  await waitFor(() => evalInspected(frame, 'document.title').then((value) => value === cascadeTitle), 'Cascade テストページ');
  await select(frame, '[data-test-target="layer"]');
  await frame.$eval('input[name="scope"][value="single"]', (input) => input.click());
  await setValue(frame, '#root-class', 'component-test');
  const layered = await analyze(frame);
  assert.match(layered.css, /^@layer first, second;/);
  assert.match(layered.css, /@layer second/);
  assert.match(layered.css, /@layer first/);
  const reproducedColor = await evalInspected(frame, `(() => {
    document.head.replaceChildren(); document.body.innerHTML = '<div class="component-test">layer</div>';
    const style = document.createElement('style'); style.textContent = ${JSON.stringify(layered.css)}; document.head.append(style);
    return getComputedStyle(document.querySelector('.component-test')).color;
  })()`);
  assert.equal(reproducedColor, 'rgb(0, 0, 255)');
  console.log('✓ @layer の順序と表示色を保持');

  const css = await readFile(resolve('tests/cross-origin.css'));
  const cssOrigin = await serve((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/css' }); response.end(css);
  });
  const html = `<!doctype html><title>${externalTitle}</title><link rel="stylesheet" href="${cssOrigin}/cross-origin.css"><div class="external-pad" data-test-target="external">外部 CSS</div>`;
  const pageOrigin = await serve((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html);
  });
  await inspected.goto(pageOrigin);
  await waitFor(() => evalInspected(frame, 'document.title').then((value) => value === externalTitle), '外部 CSS ページ');
  await waitFor(() => evalInspected(frame, 'getComputedStyle(document.querySelector("[data-test-target=external]")).paddingTop').then((value) => value === '16px' || value === '32px'), '外部 CSS の読み込み');
  await select(frame, '[data-test-target="external"]');
  await frame.$eval('input[name="scope"][value="single"]', (input) => input.click());
  await setValue(frame, '#root-class', 'external-result');
  const recovered = await analyze(frame);
  assert.match(recovered.css, /\.external-result \{\s+padding-top: 1rem/);
  assert.match(recovered.css, /@media \(min-width: 700px\)/);
  assert.match(recovered.status, /外部CSS 1 件を補完しました/);
  assert.equal(recovered.warnings, '');
  console.log('✓ 別オリジン CSS を DevTools リソースから補完');

  await evalInspected(frame, `(() => { const sheets = Array.from(document.styleSheets); Object.defineProperty(document, 'styleSheets', { configurable: true, get: () => [...sheets, { href: ${JSON.stringify(missingUrl)}, disabled: false, get cssRules() { throw new DOMException('unavailable', 'SecurityError'); } }] }); return true; })()`);
  const missing = await analyze(frame);
  assert.match(missing.css, /\.external-result \{\s+padding-top: 1rem/);
  assert.match(missing.status, /外部CSS 1 件を補完しました/);
  assert.match(missing.warnings, /DevToolsにリソースがありません/);
  assert.match(missing.warnings, /example\.invalid\/component-css-extractor-missing\.css/);
  console.log('✓ 補完できない CSS の警告と正常な CSS の保持');
} finally {
  await browser?.close();
  await Promise.all(servers.map((server) => new Promise((done) => server.close(done))));
}
