# CSS Cascade の競合・依存に関する調査（Issue #5）

この調査では抽出ロジックを変更しない。再現ページは `tests/cascade-investigation-fixture.html`。Chrome でファイルを直接開き、各対象要素を選択して「選択要素のみ」、ルートクラス `component-test` で解析する。下表の現行 CSS は、同じ入力に相当するスナップショットを現行の `generateOutput()` に渡して確認したもの。ブラウザ側の期待は [CSS Cascade Level 5](https://www.w3.org/TR/css-cascade-5/)、[:where() の詳細度](https://www.w3.org/TR/selectors-4/#zero-matches)、[style 属性の優先順位](https://www.w3.org/TR/css-style-attr/)に基づく。

この文書は調査時点の記録である。レイヤー順序の欠落は Issue #7 で修正し、名前付きレイヤーの初出順から順序宣言を再構成するようになった。関数内状態の欠落は Issue #8 で修正し、`:where()` と `:is()` の単純な引数内にある状態を対象判定時だけ除くようになった。

| ケースと最小入力 | 元ページの表示 | 現行の抽出結果 | コピー先・CSS 単独での差 | 推奨する扱い |
| --- | --- | --- | --- | --- |
| `@layer first, second; @layer second { .layer-target { color: blue } } @layer first { .layer-target { color: red } }` | 青。先に宣言した順序では `second` が後のレイヤー | `@layer second { .component-test { color: blue } }`、続いて `@layer first { .component-test { color: red } }`。順序宣言は消える | コピー先で `first` が後のレイヤーとなり赤 | 順序宣言を保持できる場合は正しく抽出。保持できない場合は誤出力を警告 |
| `.where-target { color: blue } .where-target:where(:hover) { color: red }` を非ホバーで選択 | 通常は青、ホバーで赤 | `.component-test { color: blue }` のみ。ホバーのルールは収集されない | コピー先でホバーしても青 | 静的な一致を安全に判定できる状態セレクタは抽出し、判定不能なら省略理由を警告 |
| `<div class="inline-target" style="color:red">` と `.inline-target { color: blue }` | 赤 | CSS は `.component-test { color: blue }`。HTML には `style="color:red"` が残る | HTML と CSS の両方なら赤を再現。CSS だけを別 HTML に適用すると青 | CSS 単独コピーではインラインスタイルが欠けることを警告 |
| `<div class="inheritance-parent"><div class="inheritance-target">…</div></div>` と `.inheritance-parent { color: purple } .inheritance-target { font-weight: 700 }`。内側だけを選択 | 紫で太字 | `.component-test { font-weight: 700 }` のみ | コピー先では太字だが紫色ではない | 選択範囲外の継承依存を警告。値の自動固定は行わない |

## 現状と原因

- `src/inspector/inspect-page.ts` は `cssRules` のうちスタイルルール、`@import`、子ルールを持つグループだけを処理する。ルールを持たない `@layer first, second;` はスナップショットに残らない。`src/css/generate-css.ts` は各宣言の `@layer` 文脈を出力するが、レイヤー順序の情報は再構築できない。
- `src/css/selectors.ts` の `selectorForStateMatching()` は最上位の `:hover` などだけを取り除く。`:where(:hover)` のように関数内にある状態は残るため、非ホバー時の `Element.matches()` が偽になり、そのルールは収集されない。`:where()` 自体は詳細度が常に 0 で、単に元のセレクタを保持して出力する場合はブラウザが詳細度を処理できる。今回の問題は主にルールの取り逃しである。
- `ElementNode.attributes` と `originalHtml` には `style` 属性が入るが、CSS 宣言の収集対象にはならない。したがって CSS 単独の出力とブラウザの見た目が異なる。HTML と CSS の組み合わせでは、現状でもインラインスタイルは残る。
- 選択範囲外の親要素の通常プロパティは、選択ノードと一致するルールとしては収集されない。継承された値を CSS 出力に追加する処理もない。CSS カスタムプロパティについては Issue #3 で未定義参照の警告を追加済みだが、`color` などの通常プロパティは対象外。

## 優先順位と分割方針

1. **レイヤー順序**: 色などが逆転する明確な誤出力。順序宣言の収集・再出力を先に実装し、収集できない場合は警告する。`PageSnapshot` に順序情報が必要。出力 UI の新しい操作は不要。
2. **関数内の状態セレクタ**: ホバー等のルールが黙って欠落する。`selectorForStateMatching()` と `inspectPage()` の一致判定を局所的に改め、安全に扱えない形は警告する。既存の複雑セレクタ警告と重複しないようにする。
3. **選択範囲外の継承**: `color` やフォント系の差を診断する。元 CSS を計算済み値で置き換えず、診断だけに限定する。対象プロパティと祖先条件を絞る必要がある。
4. **インラインスタイル**: CSS 単独利用時の不足を明示する。既存の HTML と CSS の両方をコピーする動作は維持し、CSS 出力や優先順位計算を変えない。

この 4 件を [#7 レイヤー順序](https://github.com/Olein-jp/component-css-extractor/issues/7)、[#8 関数内の状態](https://github.com/Olein-jp/component-css-extractor/issues/8)、[#9 継承色](https://github.com/Olein-jp/component-css-extractor/issues/9)、[#10 インラインスタイル](https://github.com/Olein-jp/component-css-extractor/issues/10) に分けた。アニメーション、トランジション、ユーザースタイル、Shadow DOM、`@property` の非継承設定まで含む完全な Cascade 再現は今回の範囲外とする。

## 検証方針と影響

- 各後続 Issue では再現ページの対象と、対応する最小の単体テストを使う。既存の正常な単純クラス、`!important`、メディア条件、外部 CSS 補完、コピー HTML のテストを維持する。
- レイヤー順序では宣言・ブロック・`!important` の向き、別シートにまたがる順序を確認する。`@layer` を無効にした設定で順序宣言だけ残さない。
- 関数内状態では非ホバー時にホバールールを取り逃がさないこと、関数内の静的条件を誤って外さないことを確認する。
- 継承とインラインスタイルの対応は警告のみとし、CSS・HTML の既存形式を変えない。警告が不要な場合には表示されないことも確認する。
- リリース前には Chrome で `tests/cascade-investigation-fixture.html` を開いて表示と抽出結果を比較する。調査時点ではローカルのヘッドレス Chrome が終了コード 134 で起動できず、ブラウザ自動操作からのローカルファイル表示も URL ポリシーで拒否されたため、実ブラウザ比較は未実施。ブラウザ上の期待表示は上記の仕様に基づく。
