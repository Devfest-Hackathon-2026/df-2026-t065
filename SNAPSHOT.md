# 提出用スナップショット

- 開発用ソースSHA: `448e131d28d9e39820a7ed9cd3dadada0eea609f`
- 提出先の準備開始時main: `e9090a9219826dd35b16fefd1a0dfae5202b02c2`
- 提出先: `Devfest-Hackathon-2026/df-2026-t065`
- 取得日: 2026-11-10（日本時間）

## 含めたもの

`src/`、`public/`、`data/phrases/`、合成の単体・契約・ブラウザテスト、`package.json`・lockfile、TypeScript/Next.js/ESLint/Vitest設定、オフラインworker生成スクリプト、Dockerfile、カード単独用`.env.example`、著作物台帳、文言検証記録、安全方針、AI利用記録。

`src/`・`public/`・対訳JSON/TypeScript・ビルドスクリプト・package/lockfile・Next.js設定は固定ソースとバイト単位で一致する65ファイルを確認した。G3の本番承認定数falseと、停止時の本文読取前拒否を変更していない。

## 提出用の調整

- 提出先のREADME本文を保持し、作品概要・実行方法・検証範囲・公開未確認状態を追記した。既存MIT LICENSEは一切変更していない。
- `.env.example`は`GEMINI_ENABLED=false`・`MOCK_GEMINI=false`だけの例にした。Dockerfileは処理を保持し、内部文書への旧コメントを公開向け説明にした。
- テスト1ファイルのプロジェクト識別子を例示値へ変更し、別のテスト1行の既存末尾空白を除去した。実API・実認証を使うテストではない。
- 文言検証は既存記録の必要部分を抜粋した。食事制約の改訂5件はdraft、一次資料REF-002はUNVERIFIEDのまま。過去のPASSを現在の改訂文言へ流用していない。
- 著作物台帳から同梱しない運用Action/運営調査の行を除外した。依存ライセンスのメタデータ一覧は[data/DEPENDENCY_LICENSES.csv](data/DEPENDENCY_LICENSES.csv)。依存物本体は同梱していない。

## 除外したものと検証範囲

Privateの`.git`履歴、AIエージェント設定、GitHub Actions（CI・WIF・デプロイ）、内部IAM/Firestore証跡・公開操作runbook、実Firestore試験ハーネスとそれ専用テスト、除外した運用ファイル専用のテストは提出物に含めない。

提出用`npm run verify`は、この選別後に残るアプリとテストを検証する。開発用の全68テストファイルを再実行したとの主張ではない。クラウドの公開、実Gemini、実Firestore、Dockerイメージのビルド・起動はこの検証で証明しない。

本スナップショットは提出先の履歴だけを持つ別checkoutへ、固定ソースをファイルとしてコピーして準備した。Privateのリポジトリを提出先の親コミットやremoteにしていない。履歴付きのpush・Git bundleは使用しない。

最終検証結果は[docs/VALIDATION.md](docs/VALIDATION.md)を参照。
