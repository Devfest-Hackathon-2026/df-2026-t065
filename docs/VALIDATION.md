# 提出用検証記録

以下の文言検証は開発用固定版からの抜粋です。この提出準備で新たに人間レビューしたとの主張ではありません。クラウドの実動作・一般公開・実Gemini呼出しの成功を示すものではありません。

<a id="phrase-checks"></a>
## 6. 確認カード文言の検証記録（`#phrase-checks`）

[`src/contracts/phrases.ts`](../src/contracts/phrases.ts) および [安全方針](SAFETY.md) に基づく、[`data/phrases/phrases.json`](../data/phrases/phrases.json) 全19件の逆翻訳（`back_translation`）・公的用語照合（`official_term_check`）・バイリンガル確認（`bilingual_member_review`）の証跡。

- **検証日 (`reviewedAt`)**: `2026-11-08`
- **検証者役割 (`reviewerRole`)**: `team member B`（個人名は記載しない方針に準拠）
- **検証レベル (`level`)**: `team_reviewed`
- **機械翻訳の下書き利用 (`machineTranslationUsedForDraft`)**: `false`（すべてチーム内で原文作成・逆翻訳確認を実施。機械翻訳を検証手段として用いていない）
- **公的アレルゲン用語参照元（`data/SOURCES.csv` `REF-001`）**:
  - 日本語: 消費者庁「食品表示基準」（特定原材料8品目：えび・かに・くるみ・小麦・そば・卵・乳・落花生、特定原材料に準ずるもの：大豆・ごま・魚介類等）
  - 英語: U.S. FDA Food Allergies (FALCPA / FASTER Act: Crustacean shellfish [shrimp/prawns, crab], Tree nuts [walnuts], Wheat, Egg, Milk/Dairy, Peanuts, Soybeans/Soy, Sesame, Fish) および Buckwheat (soba)

| ID | 用途 (`purpose`) | アレルゲン | 日本語原文 (`texts.ja`) | 英語原文 (`texts.en`) | 逆翻訳（英語→日本語の独立照合）と補足表現の確認 | 手法 (`methods`) | 判定 |
|---|---|---|---|---|---|---|---|
| `NOTICE_ALLERGY_HEADER` | `notice` | ― | 私には食物アレルギーがあります。命に関わるため、以下の食材（原材料・だし・調味料）および調理環境（器具・揚げ油等の共有）について確認をお願いします。 | I have a serious food allergy. Please help me check whether the following ingredients (including broth and seasonings) or cooking conditions (shared utensils or frying oil) apply. | 「私には重篤な食物アレルギーがあります。以下の食材（だし・調味料を含む）や調理環境（器具・揚げ油の共有）が当てはまるか確認にご協力ください。」（重篤性・原材料と交差接触の双方の確認意図が一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_SHRIMP` | `allergen_question` | `shrimp` | この料理に「えび」（えびエキス・干しえび・桜えび・シュリンプペースト・魚介だし等を含む）は入っていますか？ | Does this dish contain shrimp or prawns (including shrimp extract, dried or sakura shrimp, shrimp paste, or seafood broth)? | 「この料理にえび・クルマエビ類（えびエキス、干しえび・桜えび、シュリンプペースト、魚介だしを含む）は入っていますか？」（shrimp/prawns 両表記と干しえび・桜えび・エキス・だし類の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_CRAB` | `allergen_question` | `crab` | この料理に「かに」（かにエキス・かにみそ・かにペースト・かにだし等を含む）は入っていますか？ | Does this dish contain crab (including crab extract, crab tomalley/paste, or crab broth)? | 「この料理にかに（かにエキス、かにみそ／かにペースト、かにだしを含む）は入っていますか？」（エキス・かにみそ・ペースト・だしの補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_WALNUT` | `allergen_question` | `walnut` | この料理に「くるみ」（くるみ油・砕いたくるみ・ナッツペースト等を含む）は入っていますか？ | Does this dish contain walnuts (including walnut oil, crushed walnuts, or nut paste)? | 「この料理にくるみ（くるみ油、砕いたくるみ、ナッツペーストを含む）は入っていますか？」（油・破砕片・ペーストの補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_WHEAT` | `allergen_question` | `wheat` | この料理に「小麦」（小麦粉・醤油・パン粉・衣・つなぎ・ルー・麦味噌等を含む）は入っていますか？ | Does this dish contain wheat (including wheat flour, regular soy sauce, breadcrumbs, batter, binder, roux, or wheat/barley miso)? | 「この料理に小麦（小麦粉、一般的な醤油、パン粉、衣、つなぎ、ルー、麦味噌を含む）は入っていますか？」（醤油・衣・つなぎ・ルー等の隠れ小麦源の補足が1対1で一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_BUCKWHEAT` | `allergen_question` | `buckwheat` | この料理に「そば」（そば粉・そば麺・そば茶・そば湯等を含む）は入っていますか？ | Does this dish contain buckwheat / soba (including buckwheat flour, soba noodles, soba tea, or soba broth/soba-yu)? | 「この料理にそば（そば粉、そば麺、そば茶、そば湯を含む）は入っていますか？」（原材料としてのそば類に限定し、共有茹で湯の交差接触は `Q_CROSS_CONTACT` で分離確認） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_EGG` | `allergen_question` | `egg` | この料理に「卵」（鶏卵・うずら卵・マヨネーズ・衣・つなぎ・卵白・卵黄等を含む）は入っていますか？ | Does this dish contain egg (including chicken or quail egg, mayonnaise, batter, binder, egg white, or egg yolk)? | 「この料理に卵（鶏卵・うずら卵、マヨネーズ、衣、つなぎ、卵白、卵黄を含む）は入っていますか？」（マヨネーズ・衣・つなぎ等の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_MILK` | `allergen_question` | `milk` | この料理に「乳・乳製品」（牛乳・バター・チーズ・生クリーム・ヨーグルト・ホエイ・カゼイン等を含む）は入っていますか？ | Does this dish contain milk or dairy (including cow's milk, butter, cheese, cream, yogurt, whey, or casein)? | 「この料理に乳・乳製品（牛乳、バター、チーズ、クリーム、ヨーグルト、ホエイ、カゼインを含む）は入っていますか？」（乳製品・乳たんぱく質の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_PEANUT` | `allergen_question` | `peanut` | この料理に「落花生（ピーナッツ）」（ピーナッツオイル・ピーナッツバター・ピーナッツソース・砕いたピーナッツ等を含む）は入っていますか？ | Does this dish contain peanuts (including peanut oil, peanut butter, peanut sauce, or crushed peanuts)? | 「この料理にピーナッツ（ピーナッツオイル、ピーナッツバター、ピーナッツソース、砕いたピーナッツを含む）は入っていますか？」（オイル・ソース等の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_SOY` | `allergen_question` | `soy` | この料理に「大豆」（醤油・味噌・豆腐・豆乳・大豆油・枝豆・きな粉等を含む）は入っていますか？ | Does this dish contain soy / soybeans (including soy sauce, miso, tofu, soy milk, soybean oil, edamame, or roasted soy flour [kinako])? | 「この料理に大豆（醤油、味噌、豆腐、豆乳、大豆油、枝豆、きな粉［kinako］を含む）は入っていますか？」（発酵調味料・油・きな粉の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_SESAME` | `allergen_question` | `sesame` | この料理に「ごま」（ごま油・すりごま・練りごま・ごまだれ・タヒニ等を含む）は入っていますか？ | Does this dish contain sesame (including sesame oil, ground sesame, sesame paste, sesame dressing, or tahini)? | 「この料理にごま（ごま油、すりごま、ごまペースト、ごまドレッシング、タヒニを含む）は入っていますか？」（ごま油・タヒニ等の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_ALLERGEN_FISH` | `allergen_question` | `fish` | この料理に「魚・魚介だし等」（魚類全般・かつお節や煮干し等の魚介だし・魚醤・アンチョビ・すり身・魚油等を含む）は入っていますか？ | Does this dish contain fish or fish broth (including any fish species, bonito/fish stock [dashi], fish sauce, anchovies, fish cake [surimi], or fish oil)? | 「この料理に魚または魚だし（あらゆる魚種、かつお節／魚のだし［dashi］、魚醤、アンチョビ、すり身［surimi］、魚油を含む）は入っていますか？」（魚類全般および魚介だし・魚醤・すり身の補足が一致） | `back_translation`, `official_term_check`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_BROTH_SEASONING` | `broth_seasoning_question` | ― | だし・スープ・ソース・たれ・ドレッシング・隠し味などの調味料に、該当する食材が含まれていますか？ | Are any of these allergens present in the broth (dashi), soup stock, sauces, marinades, dressings, or hidden seasonings? | 「これらアレルゲンのいずれかが、だし、スープストック、ソース、漬けだれ、ドレッシング、または隠し味等の調味料に含まれていますか？」（だし・隠し味等の意図が一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_CROSS_CONTACT` | `cross_contact_question` | ― | 鍋・フライパン・鉄板・まな板・包丁・トング・茹で湯などの調理器具を、該当する食材と共有していますか（交差接触）？ | Are pots, pans, grills, cutting boards, knives, tongs, or boiling water shared with foods containing these allergens (cross-contact)? | 「鍋、フライパン、鉄板／グリル、まな板、包丁、トング、または茹で湯を、これらアレルゲンを含む食品と共有していますか（交差接触）？」（器具・茹で湯の共有＝交差接触確認が一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `Q_FRYING_OIL` | `frying_oil_question` | ― | 同じ揚げ油やフライヤーで、該当する食材を含む料理を揚げていますか（交差接触）？ | Is the same frying oil or deep fryer used to cook foods containing these allergens (cross-contact)? | 「同じ揚げ油またはフライヤーが、これらアレルゲンを含む食品の調理に使われていますか（交差接触）？」（揚げ油・フライヤー共有＝交差接触確認が一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `ANS_CONTAINS` | `staff_answer_option` | ― | 入っています（原材料・だし・調味料に含まれます） | Yes, it contains it (in ingredients, broth, or seasonings). | 「はい、入っています（原材料、だし、または調味料に含まれます）。」（含有回答の意味が一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `ANS_DOES_NOT_CONTAIN` | `staff_answer_option` | ― | 入っていません（原材料・だし・調味料に不使用で、調理器具・揚げ油の共有もありません） | No, it does not contain it (not in ingredients, broth, or seasonings, and no shared utensils or frying oil). | 「いいえ、入っていません（原材料・だし・調味料に含まれず、調理器具や揚げ油の共有もありません）。」（安全断定を含まず、原材料・調味料・交差接触のすべてに該当しない事実回答として一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `ANS_CROSS_CONTACT_RISK` | `staff_answer_option` | ― | 調理場・油で混ざる可能性があります（原材料には不使用ですが、調理器具・茹で湯・揚げ油等を共有） | Possible cross-contact in the kitchen or frying oil (not an ingredient, but shared utensils, boiling water, or fryer). | 「調理場や揚げ油で交差接触の可能性があります（原材料には不使用ですが、調理器具・茹で湯・フライヤーを共有）。」（原材料不使用だが交差接触リスクがある回答として明確に区別） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |
| `ANS_UNSURE_OR_CHECKING` | `staff_answer_option` | ― | わかりません／確認します（厨房・責任者に確認します） | I am not sure / Let me check (I will check with the kitchen or manager). | 「わかりません／確認します（厨房または責任者に確認します）。」（保留・確認回答として一致） | `back_translation`, `bilingual_member_review` | PASS (`team_reviewed`) |

---

<a id="phrase-checks-dietary"></a>
## 食事制約文言の現行状態

以下は固定版のJSONに記録されたレビュー状態です。本提出準備で新たな人間レビューを実施したとの主張ではありません。REF-002の一次資料URL・参照箇所は未特定（UNVERIFIED）です。過去の用語照合記録を公式基準への適合保証として扱いません。

改訂5件は両言語draftのまま、画面では表示しません。変更のない20件は既存のチーム確認記録を保持しています。

| ID | 日本語 | 英語 | ja状態 | en状態 |
|---|---|---|---|---|
| DIETARY_NOTICE_01 | 食事に関する制約・条件があります。以下の食材や調理について確認させていただけますか？ | I have dietary conditions. Could you please check the following ingredients and preparation methods? | team_reviewed | team_reviewed |
| DIETARY_Q_MEAT | この料理に肉類（牛肉・豚肉・鶏肉など）は含まれていますか？ | Does this dish contain meat (beef, pork, chicken, etc.)? | team_reviewed | team_reviewed |
| DIETARY_Q_BEEF | この料理に牛肉や牛エキスは含まれていますか？ | Does this dish contain beef or beef extracts? | team_reviewed | team_reviewed |
| DIETARY_Q_PORK | この料理に豚肉やポークエキスなどの豚由来成分は含まれていますか？ | Does this dish contain pork or pork-derived ingredients? | team_reviewed | team_reviewed |
| DIETARY_Q_POULTRY | この料理に鶏肉などの鳥類の肉は含まれていますか？ | Does this dish contain poultry or chicken? | team_reviewed | team_reviewed |
| DIETARY_Q_FISH_SEAFOOD | この料理に魚介類（魚・エビ・カニ・貝類など）は含まれていますか？ | Does this dish contain fish or seafood? | team_reviewed | team_reviewed |
| DIETARY_Q_SHELLFISH | この料理に貝類や甲殻類（エビ・カニ等）は含まれていますか？ | Does this dish contain shellfish or crustaceans? | team_reviewed | team_reviewed |
| DIETARY_Q_EGG | この料理に卵は含まれていますか？ | Does this dish contain eggs? | team_reviewed | team_reviewed |
| DIETARY_Q_DAIRY | この料理に乳製品（牛乳・チーズ・バター等）は含まれていますか？ | Does this dish contain dairy products (milk, cheese, butter, etc.)? | team_reviewed | team_reviewed |
| DIETARY_Q_HONEY | この料理にはちみつは含まれていますか？ | Does this dish contain honey? | team_reviewed | team_reviewed |
| DIETARY_Q_GELATIN | この料理に動物由来のゼラチンは含まれていますか？ | Does this dish contain animal-derived gelatin? | team_reviewed | team_reviewed |
| DIETARY_Q_LARD_ANIMAL_FAT | この料理にラード（豚脂）や牛脂などの動物性油脂は使われていますか？ | Does this dish use lard or animal-derived cooking fats? | team_reviewed | team_reviewed |
| DIETARY_Q_ANIMAL_RENNET | 使用しているチーズに動物性レンネット（凝固酵素）は使われていますか？ | Does the cheese use animal-derived rennet? | team_reviewed | team_reviewed |
| DIETARY_Q_ANIMAL_BROTH | スープやタレに豚骨・牛骨・鶏ガラ等の動物由来のだしは使われていますか？ | Is animal-derived broth, such as broth made from pork bones, beef bones, or chicken carcasses, used in the soup or sauce? | draft | draft |
| DIETARY_Q_FISH_BROTH | かつおだし、煮干しだし、魚醤等の魚介系の出汁や調味料は使われていますか？ | Does this dish contain fish broth (bonito dashi, fish sauce, etc.)? | team_reviewed | team_reviewed |
| DIETARY_Q_ALCOHOL_BEVERAGE | この飲料や料理にアルコール（お酒）は含まれていますか？ | Does this beverage or dish contain alcohol? | team_reviewed | team_reviewed |
| DIETARY_Q_ALCOHOL_SEASONING | 料理酒やみりん等のアルコール系調味料は使われていますか？ | Are cooking alcohol, sake, or mirin used as seasonings? | team_reviewed | team_reviewed |
| DIETARY_Q_SHARED_COOKWARE | 他の肉類や豚肉等と調理器具（フライパン、鉄板、包丁、まな板等）を共用していますか？ | Are cooking utensils, griddles, or cutting boards shared with other meats or pork? | team_reviewed | team_reviewed |
| DIETARY_Q_SHARED_FRYER | 他の肉類や豚肉等の揚げ物と同じ油・フライヤーで揚げていますか？ | Is this fried in the same oil or fryer as other meats or pork? | team_reviewed | team_reviewed |
| DIETARY_Q_MEAT_DAIRY_MIXING | 肉類と乳製品（チーズや牛乳等）を同一の鍋や器具で一緒に調理していますか？ | Are meat and dairy products cooked together or prepared using the same cookware? | team_reviewed | team_reviewed |
| DIETARY_Q_SLAUGHTER_METHOD | 使用しているお肉は特定の規定（ハラール対応等）に則って処理・屠畜されたものですか？ | Was the meat processed and slaughtered according to specific dietary rules (e.g. Halal)? | draft | draft |
| DIETARY_Q_CERTIFICATION_CHECK | この料理やお店は公式な食事規定（ハラール／コーシャ等）の認証を受けていますか？ | Does this dish or restaurant have official dietary certification (Halal, Kosher, etc.)? | draft | draft |
| DIETARY_ANS_YES | はい | Yes | draft | draft |
| DIETARY_ANS_NO | いいえ | No | draft | draft |
| DIETARY_ANS_UNKNOWN | 確認できません・わかりません | Cannot confirm / Not sure | team_reviewed | team_reviewed |


## 提出スナップショットの検証（2026-11-10 JST）

固定ソースSHA: `448e131d28d9e39820a7ed9cd3dadada0eea609f`。Node.js 24.22.1、npm 11.9.0、ローカルChromiumで実施。

| 検査 | 結果 |
|---|---|
| 選別後のクリーン依存インストール | 成功。既存のESLint peer dependency警告あり。バージョン・lockfileは変更なし |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm run test` | 64 files / 1891 PASS / 1 SKIP / 14 TODO。SKIP/TODOは未検証 |
| `npm run build` | PASS。Next.js本番ビルド・11資産のハッシュ付きoffline worker生成成功 |
| `cardOnlyPublic.mjs --expect-service-worker` | PASS。PC/390pxモバイル相当、SW制御・HTTPキャッシュ無効のオフライン再読込・11カード・店員回答・日英切替・通信復帰を確認 |
| 本番UIの負の対照 | 画像選択/解析のDOM無効化を強制解除してもAPI送信0。Googleへのブラウザ通信0 |
| ローカル未認証API | 不正本文・5MiB本文の少数POSTが503 / AI_DISABLED / no-store。productionでMockを返さない |
| `npm audit --omit=dev` | 脆弱性0（この実行時点の本番依存のみ） |
| 公開前ファイル検査 | 既知の鍵・トークン形式、個人メール、内部プロジェクト/Principal、禁止パスを検査。実値の検出なし。認証URLを拒否する合成テスト1件は識別済み |
| 実クラウド・実Gemini・実Firestore・Dockerビルド | 未実施。一般公開・稼働URLの成功を主張しない |

最初の複合verifyは環境のChromium sandbox起動に失敗したため中断した。アプリやテストの安全条件は変えず、VM内ローカルChromium用の起動ラッパーで接続確認後、全64ファイルを再実行して上記結果を得た。型検査・Lint・テスト・ビルドは分割した成功結果であり、最初の複合実行を成功に書き換えていない。ブラウザ起動ラッパーは提出物に含めない。

本検証は提出候補に対する実装者側の確認であり、共同開発者本人のApprove、運営の提出受理、独立監査GOを代行しない。
