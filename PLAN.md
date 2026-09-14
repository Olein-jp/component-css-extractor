# 開発計画（仕様書 v0.1.0）

## 技術レビューと判断

- DevTools の `$0` は `chrome.devtools.inspectedWindow.eval()` から参照できる。ページ由来の値は JSON 化してパネルに渡し、画面には `textContent` で表示する。
- `document.styleSheets` の `cssRules` は別オリジンの CSS で例外になる。失敗したシートを記録して残りを処理する。Resource API からの再取得は MVP 後に扱う。
- CSSOM のグループルールを再帰走査し、出現順と `!important` を保持する。完全な Cascade 再現は行わず、判定できない競合は警告する。
- 権限は `devtools_page` のみを基本とする。ホスト権限、`tabs`、`scripting` は要求しない。
- ランタイム依存を増やさず、esbuild で TypeScript をビルドし、Vitest で純粋ロジックを検証する。
- Chrome API 依存は `src/panel/chrome.ts`、ページ上の DOM/CSSOM 収集は `src/inspector/`、抽出・生成ロジックは `src/css/` に分ける。

## Issue に分割する場合の単位

1. DevTools 拡張の基盤：Manifest、パネル、`$0` と class 一覧。
2. CSSOM 収集：シート単位の失敗処理、CSSRule の再帰走査、宣言モデル。
3. 抽出と統合：class マッチング、出現順、`!important`、競合表示。
4. グループルール：`@media` と再帰的な文脈保持。
5. 子孫解析：DOM ツリー、ノードごとの CSS、セレクタ生成。
6. 出力改善：セレクタ方式、HTML 生成、コピー操作。
7. 高度な CSS：疑似状態、`@supports`、`@container`、`@layer`、変数、外部 CSS 再取得。

MVP は 1〜5 と CSS コピー・自動テストを必須とする。6〜7 は安全に扱える範囲を実装し、未対応事項を README に記す。
