# Lecture Ink — 講義スライドへの手書き

iPadのObsidianで、PDFの講義スライドにペン・蛍光ペンで書き込み、日本語UIで復習するための個人用forkです。

[Mobile Ink Annotation](https://github.com/jepicaju862-lab/mobile-ink-annotation) の公開Basic版（upstream commit `ac4f810fe767e44a5a7adf4303a1ad74566b1165`）から派生しています。元作者はpeyote / jepicaju862-labです。有料Pro版のコード・配布物は使用していません。

## できること

- iPad / Apple Pencil向けの手書き、蛍光ペン、消しゴムと自動保存（上流の機能）。
- ペンで書き、指でページを移動。文字のハイライト・下線・取り消し線・コメント。
- 操作ラベル、設定、メッセージ、ページ移動を日本語化。
- **書き込み入りPDFを別ファイルに保存**（このforkで独自実装）。
- PDFへの書き出しにネット接続、アカウント、外部サービスは不要。

## iPadへの導入（BRAT）

1. Obsidianの「設定 → コミュニティプラグイン → 閲覧」で **BRAT** を検索し、インストールして有効にします。
2. コマンドパレットの **BRAT: Add a beta plugin for testing** を実行し、`https://github.com/ykktd/obsidian-lecture-ink` を入力します。
3. 公開済みの最新リリースを選んで追加します。
4. コミュニティプラグイン一覧で **Lecture Ink（講義スライド手書き）** を有効にします。
5. 講義PDFをVaultに入れて開き、コマンドパレットで **現在のファイルに手書き注釈を付ける** を実行します。
6. 設定の **PDFを注釈画面で開く** をオンにすると、以後はPDFをタップするだけでこの画面が開きます。

元のMobile Ink Annotationと同じPDFに同時に書き込むのは避けてください。このforkは別のプラグインID・画面・データ保存先を使います。

## 書き込み入りPDFの保存と共有

1. PDFを注釈画面で開いて書き込みます。
2. ツールバーの **その他の操作** から **書き込み入りPDFを保存** を選びます（タブのメニュー、コマンドパレットからも実行できます）。
3. 同じフォルダに `第1回-書き込み.pdf` ができます。既にあれば `第1回-書き込み-2.pdf` のように番号を付けます。
4. 新しいPDFを開いて内容を確認し、Obsidianまたは「ファイル」アプリの共有操作で送れます。

**元のPDFは変更しません。** 編集用の注釈データも残ります。出力PDFだけで他のPDFビューアーに手書き・ハイライトが表示され、コメントはPDFの標準コメントとして読めます。

元のPDFのページ・文字・埋め込みフォントを保持し、透明な手書き画像をページに重ねます。元の文字は検索・選択できますが、書き出した手書きは画像なので、一筆ごとの編集や検索はできません。編集は元のPDFをこのプラグインで開いて続け、再び別のPDFを書き出してください。別のPDFアプリで元PDFと注釈データを組み直すことはできません。

ページの縦横比が混在するPDFでは、表示用の外側の余白に書いた線は書き出し時に切れます。PDFのページ内に書いてください。

導入方法の参考：[BRAT作者の公式ガイド](https://tfthacker.com/brat-quick-guide)。

## データと既存版からの移行

編集用データはVault内の `.obsidian/plugins/obsidian-lecture-ink/annotations/` に保存されます。PDFだけでなく、このフォルダもバックアップしてください。同期サービスによっては `.obsidian` 内のプラグインデータの同期設定が必要です。

以前のMobile Ink Annotationに書き込みがある場合：

1. 以前のプラグインで保存し、PDFとVaultをバックアップします。
2. Obsidianを閉じて、以前の `.obsidian/plugins/mobile-ink-annotation-basic/annotations/` のファイルを、新しい `.obsidian/plugins/obsidian-lecture-ink/annotations/` に**コピー**します。元のデータは残します。
3. PDFのファイル名・Vault内の場所は変えずに、このforkで開いて内容を確認します。

注釈ファイル名には元PDFのパスから計算した値が含まれるため、元PDFの移動・名前変更で注釈が見えなくなる場合があります。この点は上流と同じです。プラグインを削除する前には注釈データのバックアップと書き込み入りPDFの出力を行ってください。

## 対応範囲と検証上の限界

- Obsidian 1.5.0以降。デスクトップ・モバイル対応。
- PDFの書き出しのみを追加しています。MarkdownノートのPDF化は対象外です。
- 暗号化・パスワード付きPDFはこの版では書き出せません。
- 100MB・1000ページを超えるPDFや極端に縦長のページは、分割して開いてください。ページごとの透明画像は最大400万画素に抑え、順番に処理します。小さいPDFでも大量の書き込みでiPadのメモリが不足する場合があります。
- 電子署名があるPDFの出力コピーでは署名の検証が無効になります。元PDFの署名はそのままです。
- 回転・切り抜き・大きさの異なるページの座標変換、元の文字の保持、日本語コメント、保存先の重複、保存失敗をテスト済みです。
- WebKitのiPad表示相当の検証は実機のObsidian / Apple Pencilの検証を代替しません。まず講義PDFのコピーで書き込み・閉じて再表示・出力を試してください。
- 自分で選んで開くVault内のファイルを扱うコミュニティプラグインです。監査は既知の問題やコード上の危険な経路を確認するもので、完全な安全を保証しません。

## 開発・配布

Node.js 20以降で以下を実行します。

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
```

ブラウザ検証は `node scripts/browser-test.mjs`（WebKitとmacOS版Chromeが必要）です。Obsidian APIのスタブを使ったローカルの画面検証で、実際のVaultにはアクセスしません。

配布する `main.js` はこのソースから生成し、GitHub Releaseに `manifest.json`, `main.js`, `styles.css` を添付します。BRATはこの3ファイルを使います。`pdf-lib` はバンドルに含まれ、追加のダウンロードは発生しません。PDF表示のランタイムはObsidianが提供し、日本語PDFなどに必要なCMapと標準フォントの補助データはバンドルに含めています。

## ライセンス

GPL-3.0-or-later。元のLICENSEと作者の帰属を保持しています。依存ライブラリのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。
