# Component CSS Extractor

Chrome DevTools の Elements パネルで選択した要素に付いたクラスから、元の CSS ルールを収集し、コンポーネント用のセレクタへまとめる Manifest V3 拡張です。子孫要素を含めた解析、手入力したクラスの解析、CSS と HTML のコピーに対応します。ページの DOM と CSS は変更しません。

## ローカルで読み込む

Node.js 20 以降を用意し、リポジトリで次を実行します。

```sh
npm ci
npm run check
```

Chrome で `chrome://extensions` を開き、デベロッパーモードを有効にして「パッケージ化されていない拡張機能を読み込む」から、このリポジトリの `dist` ディレクトリを選びます。対象ページで DevTools を開くと **CSS Extractor** パネルが追加されます。拡張を再ビルドした場合は拡張機能ページで再読み込みし、DevTools を開き直してください。

## 使い方

1. Elements パネルで要素を選び、**CSS Extractor** パネルを開きます。
2. 必要に応じて「子孫要素を含む」、ルートのクラス名、セレクタ方式を設定します。クラス名を直接入力する場合は「クラスを入力」を選びます。
3. 「解析する」を押して CSS と HTML を確認し、必要な内容をコピーします。

手動確認には [tests/manual-fixture.html](tests/manual-fixture.html) を利用できます。この HTML ファイルを Chrome にドラッグ＆ドロップするか、Chrome の「ファイルを開く」で選んでください。サーバーの起動は不要です。ページ内の「4. 複雑なセレクタとメディアクエリ」では、今回の `padding`、`@media`、複雑なセレクタを 1 ファイルで確認できます。

3 つの主要操作を続けて確認するには [tests/feature-fixture.html](tests/feature-fixture.html) を Chrome で直接開いてください。親クラスの安全な変換、クラスの手入力、子要素を含む解析について、操作手順と期待結果をページ内に記載しています。

追加の確認には [tests/edge-cases-fixture.html](tests/edge-cases-fixture.html) を Chrome で直接開いてください。変換できない外部条件の警告、「両方コピー」後の表示、`@media` と疑似クラスの切り替えを、ページ内の手順で試せます。

別オリジンの CSS を DevTools Resource API で補完する確認には [tests/cross-origin-online-fixture.html](tests/cross-origin-online-fixture.html) を使います。Chrome で直接開けますが、外部 CSS の取得にインターネット接続が必要です。補完できない場合の警告は、ページ内のボタンで読み取れないシートを模擬して確認できます。外部配信に依存しない環境で試す場合は、リポジトリで `python3 -m http.server 8000` と `python3 -m http.server 8001` を別々のターミナルで実行し、`http://localhost:8000/tests/cross-origin-fixture.html` を開いてください。

ルートのクラス名は出力用です。たとえば `card` と入力すると `.card` が生成されます。「既存の意味あるクラスを優先」では、子要素に CSS 抽出対象として使われなかったクラスがあれば、その名前を優先します。「コンポーネントクラスを生成」では `.card__title` などを作ります。「DOMセレクタを使用」では子要素に `.card > h2:nth-child(1)` のようなセレクタを使い、HTML は元のまま表示します。

## 仕様と制限

- CSSOM の `document.styleSheets` と `@import` を再帰的に読みます。別オリジンなどで読めないシートは DevTools Resource API から本文を再取得して補完します。補完した CSS 内の `@import` 先も、DevTools にリソースがある場合は相対 URL を解決して読み、元の位置とメディア条件を保ちます。取得不能な先、循環参照、容量上限は警告します。補完した `@import` の `layer`・`supports` 条件には未対応で、条件を無視した誤出力を避けるため該当先を省略して警告します。
- 読み取れない CSS は、リソースなし・本文取得失敗・解析失敗・容量上限などの理由と対象の代表例を警告します。表示する URL から認証情報、クエリ文字列、フラグメントを除きます。
- 元 CSS にある `@media`、`@supports`、`@container`、`@layer`、一部の疑似クラス・疑似要素、CSS カスタムプロパティ、`!important` を保持します。メディアクエリは現在の表示幅に関係なく収集します。
- 出力する宣言が `var()` で参照するカスタムプロパティについて、出力内の要素または祖先要素に定義がない場合は名前とフォールバックの有無を警告します。`:root` など選択範囲外の定義を自動でコピーしたり、計算済みの値に変換したりはしません。
- 単純なクラス複合セレクタ（例: `.foo`、`.foo.bar`、`.md\\:p-8:hover`）はコンポーネント用セレクタへ統合します。複雑なセレクタのうち、選択範囲外の単純な親クラス条件を安全に外せるものは、属性条件を残してコンポーネント用セレクタに変換します。それ以外は元の形で出力し、生成 HTML の外側への依存があれば警告します。元の形で出力するために必要なクラスは HTML に残します。手入力モードや一致を確認できない状態依存のルールは省略される場合があります。
- 完全な CSS Cascade は再現しません。同一文脈内では `!important`、単純セレクタの詳細度、元の出現順で競合を解決します。レイヤー間の順序、`:where()`、継承、インラインスタイル、アニメーションは評価しません。抽出結果を必ず確認してください。
- 生成 HTML は選択要素を複製して作り、抽出に利用したクラスを置き換えます。解析されなかったクラスや他の属性・テキストは保持します。JavaScript が参照するクラスを CSS 抽出にも利用している場合、コピー前に HTML を確認してください。
- 250 を超える子孫要素は先頭 250 件まで解析します。Shadow DOM と adoptedStyleSheets は対象外です。手入力モードでは実 DOM の状態を確認できないため、単純セレクタのクラス一致で抽出します。

## 開発

```sh
npm run typecheck
npm test
npm run build
```

実際の Google Chrome に `dist` を拡張として読み込み、主要操作を自動確認するには次を実行します。テスト中は専用の Chrome ウィンドウが開き、完了後に自動で閉じます。通常の Chrome を標準の場所にインストールしていない場合は、`CHROME_BIN` に実行ファイルのパスを指定してください。

```sh
npm run test:browser
```

このブラウザテストは、固定されたローカルデータだけを使い、Elements で選択した要素、入力したクラス、子孫要素を含む解析に加え、別オリジン CSS の補完成功と補完失敗時の警告を確認します。外部通信は行いません。自動化にはブラウザを同梱しない `puppeteer-core` を使うため、依存関係のインストール時に数百 MB のテスト用ブラウザを取得する方式を避けています。

## GitHub Releases 向けパッケージ

`npm run package:release` で現在のバージョンの ZIP（例: `release/component-css-extractor-v0.1.3.zip`）と SHA-256 チェックサムを生成します。ZIP 内の最上位フォルダを展開して、そのフォルダを Chrome の「パッケージ化されていない拡張機能を読み込む」で指定します。ZIP をそのまま Chrome に渡してインストールする方式ではありません。

`package.json` と `manifest.json` のバージョンを揃えたうえで、そのバージョンのタグ（例: `v0.1.3`）を、ワークフローを含むコミットに付けてプッシュすると、GitHub Actions が型チェック・単体テスト・Chrome 拡張のブラウザテスト・ZIP 検証を実行し、ZIP とチェックサムを GitHub Release に添付します。テストまたはバージョン照合が失敗した場合は Release を作成しません。タグはブランチのコミットをプッシュした後に付けてください。

```sh
git push origin main
git tag v0.1.3
git push origin v0.1.3
```

GitHub Actions では自動発行される `GITHUB_TOKEN` を使うため、追加のトークンをリポジトリに登録する必要はありません。ローカルからのプッシュには、通常どおり GitHub の認証が必要です。

実装順序と Issue 分割案は [PLAN.md](PLAN.md) に記載しています。拡張にホスト権限や `tabs` 権限は付与していません。DevTools の `$0` を参照するため、`devtools_page` から `chrome.devtools.inspectedWindow.eval()` を使用します。
