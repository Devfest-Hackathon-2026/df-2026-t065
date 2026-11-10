# メニュー解析のオフライン評価（B側・テスト専用）

合成データを、本番の解析経路（`handleAnalyzeMenu`）に偽モデル経由で通し、後処理と安全不変条件を評価します。
**実Gemini・Vertex AI・GCPは一切呼び出しません**（評価中は `fetch` をブロックし、試行回数を記録します）。

> これは**後処理・安全性のオフライン評価**です。**実モデルの精度評価ではありません**（実モデルの精度は未検証）。

## 実行

| 目的 | コマンド |
|---|---|
| 通常（`npm test` に含まれる） | `npx vitest run tests/server/evaluation` |
| レポート生成 | `EVAL_REPORT=1 npx vitest run tests/server/evaluation/offlineEvaluation.test.ts` → `test-results/offline-eval/report.{json,md}`（git管理外） |
| ベースライン更新（結果が変わった理由を確認した後だけ。安全ゲートがNGの間は書き込まない） | `EVAL_UPDATE_BASELINE=1 npx vitest run tests/server/evaluation/offlineEvaluation.test.ts` |
| 記録済み出力の評価（承認後） | `EVAL_RECORDED_DIR=<dir> npx vitest run tests/server/evaluation/recorded.test.ts` → `test-results/offline-eval/recorded-report.{json,md}` |

## 構成

| ファイル | 役割 |
|---|---|
| `types.ts` | ケース・結果の型、網羅領域（16種）、不変条件ID |
| `cases.ts` | 合成ケース（`SYNTHETIC TEST DATA`。モデルが返す生テキストとして記述） |
| `engine.ts` | 評価対象（本番経路＋偽モデル）と、**契約ヘルパーを使わない独立オラクル** |
| `report.ts` | JSON/Markdown レポート、ベースライン比較（回帰検出）、コミットSHA |
| `baseline.json` | ケースごとの結果のスナップショット（**回帰検出専用**。安全違反の許容には使わない） |
| `knownFailures.ts` | 既知FAILの明示的許容（ケースID×検査ID・理由・関連・解除条件）と、宣言済みの未検証ケース |
| `recorded.ts` | 今後の実Gemini記録出力を同じ形式で評価する拡張点（呼び出しは実装しない） |
| `*.test.ts` | 評価本体、故障注入（負の対照）、記録出力形式、独立監査（PR #18）指摘の負の対照（`auditRevise.test.ts`） |

## 判定の考え方

- **期待値（`expect`）は人が書く**。実装から導出しない。期待値を実装に合わせて緩めない。
- **独立オラクル**: `findIntegrityViolations` や `normalizeForMatch` 等の契約ヘルパー、zod スキーマを使わずに検査する。後処理側の不具合が評価側の同じ不具合で隠れないようにするため。
- ケース結果: いずれかの検査が FAIL → **FAIL**、FAIL がなく未検証あり → **未検証**、それ以外 → **PASS**。
- **出力だけでは判断できない事項は「未検証」**（例: 実モデルが画像内の命令に従わないか、誤読で消えた含有記載の検出、訳文中の「安全」が原文の訳かAIの断定か）。
- 精度軸（`accuracyFindings`）: 参照値（合成メニューの正解）と出力の差。合成ケースでは**意図的に注入した欠陥を検出できるか**の確認であり、実モデルの誤り率ではない。
- 自由文の安全断定は語句検出（補助策）。根拠文（rationale）は AI 自身の文なので FAIL（人による確認対象）、訳文は原文の訳の可能性があるので未検証。**文字列一致だけで安全性や違反を確定しない。**
- **構造検査（INV-STRUCTURE）**: 応答の全要素を、独立に定義したキー集合・型・列挙値で検査する。`null` や不正な要素を `filter` で黙って除外しない。
- **ログの語彙（INV-LOG-VOCABULARY）**: ログの `failure` が既知の固定コード以外なら、ほかが正常でも単独で FAIL。値そのものは出力しない。
- **言語タグ**: `readText.lang`（null 可）と `aiTranslation.lang`（必須）を、契約と同じ文法（主サブタグ 2〜3 小文字、以降 `-` 区切りで 2〜8 英数字）で、契約の正規表現を使わず独立に検査する。
- **レポートの安全性**: 未知のキー名・列挙値・ログの値は転記しない。固定の語彙・添字・件数と、`<unknown-key>` / `<invalid>` / `unrecognized_failure` などの固定値だけを出力する。

## 安全ゲートとベースライン（2つは独立）

| 仕組み | 役割 | 更新で変えられること |
|---|---|---|
| 安全ゲート（`knownFailures.ts`） | すべての FAIL が「ケースID×検査ID」の完全一致で許容されているか。許容が陳腐化していないか。未検証ケースが宣言どおりか | 許容の追加・削除は**安全上の判断**。A・B 双方のレビューが必要（テストで一覧を固定しているため差分に必ず現れる） |
| `baseline.json` | 通常出力の回帰検出 | 結果の変化を確認した後に更新できる。**更新しても新規の安全FAILは通らない** |

- テストが成功する ＝「未承認のFAILがなく、回帰もない」。**全ケースが PASS という意味ではない**（4ケースは設計上「未検証」）。現在、既知FAILの許容は 0 件。
- 許容した FAIL が FAIL でなくなったら、陳腐化としてテストが失敗する。修正後は `knownFailures.ts` の該当行を削除する。
- 宣言済みの未検証ケースが PASS に変わった場合も失敗する（未検証を PASS に書き換えない）。

## 既知の問題と対応状況

- **EV-052（本番修正済み・合成評価で PASS）**: AI推測の根拠文（`rationale`）に安全断定が含まれても最終出力へ通していた問題。本番の後処理（`src/server/gemini/modelOutput.ts`）で、AI由来の `rationale` を公開契約で検証した後に**常に `null`** にし、`analyzeWithGemini.ts` の最終チェックで非 `null` が残れば `AI_FAILED`（`ai_rationale_not_redacted`）にする。`knownFailures.ts` の許容は削除済み。
  - EV-052 の `INV-FREE-TEXT-VERDICT` は `not_applicable`（公開される根拠文がなく、検査対象がない）。**これは AI の自由文が安全だという意味ではない。**
  - 合成出力（偽モデル）での確認にとどまり、**実Geminiでの安全性は未検証**。
  - トレードオフ: 画面に AI 推測の理由が表示されない（区分・「実原材料は未確認」・「店員への確認必須」の表示は残る）。
  - Mock（開発・テスト専用、`mock_fixture`）のフィクスチャには `rationale` が残っており、開発画面では表示される。本番では Mock は使えない。
- **EV-044（未検証のまま）**: 注入文の訳に「安全」が含まれる。原文の訳かAIの断定かは出力だけでは判別できない。**`aiTranslation`・`readText`・`menu_mentions` の `excerpt`・`menuNotices` の AI 自由文は今回の修正の対象外**で、安全断定や誤訳が残り得る（UI では AI の読み取り・訳であることと要確認を表示）。

## 記録出力（実Gemini）への接続

`recorded.ts` の形式（strict。料金・画像・認証情報のフィールドは拒否）で保存した出力を、偽モデルで再生して同じ評価を行う。

- `source: "recorded_gemini"` は `approval.approvedModel` と `model` の一致が必須。
- 参照値は承認済み合成画像ごとに `SYNTHETIC_IMAGE_REFERENCES` に登録する（**現在は空**）。画像の sha256 が一致しない場合は精度比較を行わず未検証にする。
- 実Gemini呼び出し・GCP認証・料金記録・本番カウンター利用は本ツールに実装しない（AGENTS.md §4 の承認が必要）。
