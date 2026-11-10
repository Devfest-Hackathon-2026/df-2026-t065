import { z } from "zod";
import { VerificationRecordSchema } from "./phrases";

/*
 * Dietary restrictions and religious dietary condition contract.
 *
 * This contract covers dietary conditions (Vegan, Vegetarian, Halal check, Kosher check, custom).
 * SAFETY INVARIANT: The app NEVER asserts compliance, safety, or edibility.
 * Conditions are strictly customer-specified inquiry items presented to restaurant staff.
 * Presets and religious labels are NEVER sent to the AI backend or stored on servers.
 */

export const DIETARY_PRESET_IDS = [
  "vegan",
  "lacto_ovo_vegetarian",
  "lacto_vegetarian",
  "ovo_vegetarian",
  "pescatarian",
  "halal_check",
  "kosher_check",
  "custom",
] as const;
export const DietaryPresetIdSchema = z.enum(DIETARY_PRESET_IDS);
export type DietaryPresetId = z.infer<typeof DietaryPresetIdSchema>;

export const DIETARY_CONDITION_CODES = [
  // Meats & animal by-products
  "meat",
  "beef",
  "pork",
  "poultry",
  "fish_seafood",
  "egg",
  "dairy",
  "honey",
  "gelatin",
  "lard_animal_fat",
  "animal_rennet",
  "shellfish",
  // Broths & Seasonings
  "animal_broth",
  "fish_broth",
  "alcohol_beverage",
  "alcohol_seasoning",
  // Preparation & Equipment
  "shared_cookware",
  "shared_fryer",
  "meat_dairy_mixing",
  "slaughter_method",
  "certification_check",
] as const;
export const DietaryConditionCodeSchema = z.enum(DIETARY_CONDITION_CODES);
export type DietaryConditionCode = z.infer<typeof DietaryConditionCodeSchema>;

export const DietaryConditionCategorySchema = z.enum([
  "meat_animal_derived",
  "broth_seasoning",
  "preparation_equipment",
]);
export type DietaryConditionCategory = z.infer<typeof DietaryConditionCategorySchema>;

export type DietaryConditionDefinition = {
  readonly code: DietaryConditionCode;
  readonly category: DietaryConditionCategory;
  readonly labelJa: string;
  readonly labelEn: string;
  readonly descriptionJa: string;
  readonly descriptionEn: string;
};

export const DIETARY_CONDITIONS: readonly DietaryConditionDefinition[] = [
  {
    code: "meat",
    category: "meat_animal_derived",
    labelJa: "肉類全般（牛・豚・鶏等）",
    labelEn: "All Meats (beef, pork, chicken, etc.)",
    descriptionJa: "牛肉、豚肉、鶏肉などの食肉全般を避ける",
    descriptionEn: "Avoid all meats including beef, pork, and chicken",
  },
  {
    code: "beef",
    category: "meat_animal_derived",
    labelJa: "牛肉・牛エキス",
    labelEn: "Beef & Beef extracts",
    descriptionJa: "牛肉および牛肉由来のエキス・成分を避ける",
    descriptionEn: "Avoid beef and beef-derived extracts",
  },
  {
    code: "pork",
    category: "meat_animal_derived",
    labelJa: "豚肉・豚由来成分",
    labelEn: "Pork & Pork derivatives",
    descriptionJa: "豚肉、ポークエキス、豚ゼラチン等の豚由来成分を避ける",
    descriptionEn: "Avoid pork meat and any pork-derived ingredients",
  },
  {
    code: "poultry",
    category: "meat_animal_derived",
    labelJa: "鶏肉・鳥類肉",
    labelEn: "Poultry (chicken, etc.)",
    descriptionJa: "鶏肉やその他の鳥類の肉を避ける",
    descriptionEn: "Avoid chicken and other poultry meats",
  },
  {
    code: "fish_seafood",
    category: "meat_animal_derived",
    labelJa: "魚介類全般",
    labelEn: "Fish & Seafood",
    descriptionJa: "魚介類（魚、エビ、カニ、貝類など）全般を避ける",
    descriptionEn: "Avoid all fish and seafood",
  },
  {
    code: "shellfish",
    category: "meat_animal_derived",
    labelJa: "貝類・甲殻類",
    labelEn: "Shellfish & Crustaceans",
    descriptionJa: "貝類、エビ、カニなどを避ける",
    descriptionEn: "Avoid shellfish, shrimp, crab, etc.",
  },
  {
    code: "egg",
    category: "meat_animal_derived",
    labelJa: "卵",
    labelEn: "Eggs",
    descriptionJa: "鶏卵などの鳥類の卵を避ける",
    descriptionEn: "Avoid eggs",
  },
  {
    code: "dairy",
    category: "meat_animal_derived",
    labelJa: "乳製品（牛乳・チーズ・バター等）",
    labelEn: "Dairy products (milk, cheese, butter)",
    descriptionJa: "牛乳、チーズ、バター、ヨーグルト等の乳製品を避ける",
    descriptionEn: "Avoid milk, cheese, butter, and dairy products",
  },
  {
    code: "honey",
    category: "meat_animal_derived",
    labelJa: "はちみつ",
    labelEn: "Honey",
    descriptionJa: "蜂由来のはちみつを避ける",
    descriptionEn: "Avoid bee honey",
  },
  {
    code: "gelatin",
    category: "meat_animal_derived",
    labelJa: "ゼラチン",
    labelEn: "Gelatin",
    descriptionJa: "動物の骨や皮由来のゼラチンを避ける",
    descriptionEn: "Avoid animal-derived gelatin",
  },
  {
    code: "lard_animal_fat",
    category: "meat_animal_derived",
    labelJa: "ラード・動物性油脂",
    labelEn: "Lard & Animal fats",
    descriptionJa: "豚脂（ラード）、牛脂（ヘット）、鶏油などの動物性油を避ける",
    descriptionEn: "Avoid lard, tallow, and animal-derived cooking fats",
  },
  {
    code: "animal_rennet",
    category: "meat_animal_derived",
    labelJa: "動物性レンネット（チーズ凝固酵素）",
    labelEn: "Animal rennet",
    descriptionJa: "仔牛などの胃から採取される凝固酵素を用いたチーズを避ける",
    descriptionEn: "Avoid cheese made with animal-derived rennet",
  },
  {
    code: "animal_broth",
    category: "broth_seasoning",
    labelJa: "動物由来のだし・スープ（豚骨・牛骨・鶏ガラスープ等）",
    labelEn: "Animal-derived broth & soup",
    descriptionJa: "豚骨、牛骨、鶏ガラ等からとったスープや出汁を避ける",
    descriptionEn: "Avoid broth made from pork, beef, chicken bones, etc.",
  },
  {
    code: "fish_broth",
    category: "broth_seasoning",
    labelJa: "魚介だし（かつおだし・煮干し・魚醤等）",
    labelEn: "Fish broth (bonito dashi, fish sauce, etc.)",
    descriptionJa: "かつお節、煮干し、魚醤等の魚介由来の出汁や調味料を避ける",
    descriptionEn: "Avoid fish broth, bonito flakes dashi, fish sauce, etc.",
  },
  {
    code: "alcohol_beverage",
    category: "broth_seasoning",
    labelJa: "飲料用アルコール・お酒",
    labelEn: "Alcoholic beverages",
    descriptionJa: "飲料用の酒類・アルコール分を避ける",
    descriptionEn: "Avoid drinking alcohol and alcoholic beverages",
  },
  {
    code: "alcohol_seasoning",
    category: "broth_seasoning",
    labelJa: "調理用酒・みりん等のアルコール調味料",
    labelEn: "Cooking alcohol (ryorishu, mirin)",
    descriptionJa: "料理酒、みりん、ワイン等の加熱調理に使われるアルコール調味料を避ける",
    descriptionEn: "Avoid cooking alcohol, mirin, sake, or wine used in sauces",
  },
  {
    code: "shared_cookware",
    category: "preparation_equipment",
    labelJa: "調理器具・鉄板の共用確認",
    labelEn: "Shared cookware / surfaces check",
    descriptionJa: "肉類・豚肉等と同じフライパン、包丁、まな板、鉄板を使用しているか確認する",
    descriptionEn: "Inquire if utensils, grill plates, or prep surfaces are shared",
  },
  {
    code: "shared_fryer",
    category: "preparation_equipment",
    labelJa: "揚げ油・フライヤーの共用確認",
    labelEn: "Shared frying oil check",
    descriptionJa: "肉類や豚肉等の揚げ物と同じ油・フライヤーで揚げているか確認する",
    descriptionEn: "Inquire if frying oil or fryers are shared with other meats",
  },
  {
    code: "meat_dairy_mixing",
    category: "preparation_equipment",
    labelJa: "肉と乳製品の混合調理・同時使用の確認",
    labelEn: "Meat & Dairy mixing check",
    descriptionJa: "肉類と乳製品（チーズ・牛乳等）を同一の料理や器具で混合調理していないか確認する",
    descriptionEn: "Inquire if meat and dairy are prepared or cooked together",
  },
  {
    code: "slaughter_method",
    category: "preparation_equipment",
    labelJa: "肉の由来・屠畜方法の確認（ハラール対応等）",
    labelEn: "Meat slaughter method check",
    descriptionJa: "使用している食肉が特定の規定（イスラム法等）に則って処理されたものか確認する",
    descriptionEn: "Inquire about meat sourcing and certified slaughter methods",
  },
  {
    code: "certification_check",
    category: "preparation_equipment",
    labelJa: "公式認証（ハラール／コーシャ等）の有無の確認",
    labelEn: "Official certification check",
    descriptionJa: "店舗やメニューが公式機関の認証を受けているか確認する",
    descriptionEn: "Inquire if the dish or kitchen has official dietary certification",
  },
] as const;

export type PresetDefinition = {
  readonly id: DietaryPresetId;
  readonly labelJa: string;
  readonly labelEn: string;
  readonly defaultConditions: readonly DietaryConditionCode[];
  readonly rationaleJa: string;
  readonly rationaleEn: string;
  readonly sourceReference: string;
};

export const DIETARY_PRESETS: readonly PresetDefinition[] = [
  {
    id: "vegan",
    labelJa: "ヴィーガン（完全菜食主義）",
    labelEn: "Vegan",
    defaultConditions: [
      "meat",
      "fish_seafood",
      "egg",
      "dairy",
      "honey",
      "gelatin",
      "lard_animal_fat",
      "animal_rennet",
      "animal_broth",
      "fish_broth",
    ],
    rationaleJa: "肉類、魚介類、卵、乳製品、蜂蜜、動物性油、動物性だし、レンネット等すべての動物性原料の除外",
    rationaleEn: "Excludes all animal-derived foods and ingredients (meat, fish, dairy, eggs, honey, gelatin, animal broths)",
    sourceReference: "The Vegan Society definition of veganism",
  },
  {
    id: "lacto_ovo_vegetarian",
    labelJa: "ベジタリアン（ラクト・オボ：卵・乳製品可）",
    labelEn: "Vegetarian (Lacto-Ovo)",
    defaultConditions: [
      "meat",
      "fish_seafood",
      "gelatin",
      "lard_animal_fat",
      "animal_rennet",
      "animal_broth",
      "fish_broth",
    ],
    rationaleJa: "肉類・魚介類・動物性油脂・動物由来だし・動物性レンネットを除外。卵・乳製品は許可",
    rationaleEn: "Excludes meat, seafood, animal fats, and broths, but allows eggs and dairy",
    sourceReference: "Vegetarian Society UK definition",
  },
  {
    id: "lacto_vegetarian",
    labelJa: "ラクト・ベジタリアン（乳製品可・卵不可）",
    labelEn: "Lacto-Vegetarian",
    defaultConditions: [
      "meat",
      "fish_seafood",
      "egg",
      "gelatin",
      "lard_animal_fat",
      "animal_rennet",
      "animal_broth",
      "fish_broth",
    ],
    rationaleJa: "肉類・魚介類に加え卵も除外。乳製品は許可",
    rationaleEn: "Excludes meat, fish, and eggs; allows dairy products",
    sourceReference: "Vegetarian Society UK definition",
  },
  {
    id: "ovo_vegetarian",
    labelJa: "オボ・ベジタリアン（卵可・乳製品不可）",
    labelEn: "Ovo-Vegetarian",
    defaultConditions: [
      "meat",
      "fish_seafood",
      "dairy",
      "gelatin",
      "lard_animal_fat",
      "animal_rennet",
      "animal_broth",
      "fish_broth",
    ],
    rationaleJa: "肉類・魚介類に加え乳製品も除外。卵は許可",
    rationaleEn: "Excludes meat, fish, and dairy; allows eggs",
    sourceReference: "Vegetarian Society UK definition",
  },
  {
    id: "pescatarian",
    labelJa: "ペスコ・ベジタリアン（魚介可）",
    labelEn: "Pescatarian",
    defaultConditions: [
      "meat",
      "gelatin",
      "lard_animal_fat",
      "animal_broth",
    ],
    rationaleJa: "食肉全般（牛・豚・鶏等）および動物由来出汁を除外。魚介類・卵・乳製品は許可",
    rationaleEn: "Excludes land animal meats and broths; allows fish, seafood, eggs, and dairy",
    sourceReference: "Vegetarian Society UK guidelines on pescatarian diets",
  },
  {
    id: "halal_check",
    labelJa: "ハラール確認項目プリセット",
    labelEn: "Halal check preset",
    defaultConditions: [
      "pork",
      "lard_animal_fat",
      "gelatin",
      "alcohol_beverage",
      "alcohol_seasoning",
      "slaughter_method",
      "shared_cookware",
      "shared_fryer",
      "certification_check",
    ],
    rationaleJa: "豚肉・豚由来成分、アルコール（みりん・料理酒含む）、屠畜方法、調理器具・油の共用等の店員確認項目",
    rationaleEn: "Inquiry items for pork, alcohol, cooking wines, slaughter method, and shared equipment",
    sourceReference: "Japan Muslim Association / Halal Tourism guidelines (factual inquiry reference)",
  },
  {
    id: "kosher_check",
    labelJa: "コーシャ確認項目プリセット",
    labelEn: "Kosher check preset",
    defaultConditions: [
      "pork",
      "shellfish",
      "meat_dairy_mixing",
      "shared_cookware",
      "gelatin",
      "lard_animal_fat",
      "slaughter_method",
      "certification_check",
    ],
    rationaleJa: "豚肉、貝類・甲殻類、肉と乳の混合・器具共用、屠畜方法、認証等の店員確認項目",
    rationaleEn: "Inquiry items for non-kosher meats, shellfish, meat-dairy mixing, shared equipment, and certification",
    sourceReference: "Kashrut general guidelines for travelers (factual inquiry reference)",
  },
  {
    id: "custom",
    labelJa: "個別の条件を指定",
    labelEn: "Custom conditions",
    defaultConditions: [],
    rationaleJa: "避けたい食材や調理条件を利用者が個別に選択",
    rationaleEn: "User specifies specific ingredients or cooking conditions",
    sourceReference: "User custom profile",
  },
] as const;

export const DietaryPhrasePurposeSchema = z.enum([
  "dietary_notice", // e.g. "I have dietary conditions/restrictions."
  "ingredient_question", // "Does this dish contain {item}?"
  "process_question", // "Are utensils / oil shared?"
  "staff_answer_option", // yes / no / not sure
]);
export type DietaryPhrasePurpose = z.infer<typeof DietaryPhrasePurposeSchema>;

export const DietaryPhraseSchema = z
  .object({
    id: z.string().regex(/^[A-Z0-9_]{2,64}$/),
    purpose: DietaryPhrasePurposeSchema,
    conditionCode: DietaryConditionCodeSchema.nullable(),
    texts: z.record(z.string(), z.string().min(1).max(300)),
    verification: z.record(z.string(), VerificationRecordSchema),
  })
  .strict();
export type DietaryPhrase = z.infer<typeof DietaryPhraseSchema>;
