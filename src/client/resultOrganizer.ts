import type { AllergenCode } from "@/contracts/allergens";
import type {
  AllergenAssessment,
  AnalyzeMenuResponse,
  MenuItem,
} from "@/contracts/analyze";

export type GroupedDishAssessments = {
  menu_mentions: Extract<AllergenAssessment, { category: "menu_mentions" }>[];
  ai_inferred: Extract<AllergenAssessment, { category: "ai_inferred" }>[];
  unconfirmed: Extract<AllergenAssessment, { category: "unconfirmed" }>[];
};

export type AllergenDishEntry = {
  item: MenuItem;
  assessment: AllergenAssessment;
};

export type AllergenGroupedResult = {
  code: AllergenCode;
  menu_mentions: {
    item: MenuItem;
    assessment: Extract<AllergenAssessment, { category: "menu_mentions" }>;
  }[];
  ai_inferred: {
    item: MenuItem;
    assessment: Extract<AllergenAssessment, { category: "ai_inferred" }>;
  }[];
  unconfirmed: {
    item: MenuItem;
    assessment: Extract<AllergenAssessment, { category: "unconfirmed" }>;
  }[];
};

/**
 * Separates a single dish's allergen assessments into the 3 required categories:
 * 1. menu_mentions
 * 2. ai_inferred
 * 3. unconfirmed
 */
export function groupAssessmentsByCategory(
  assessments: readonly AllergenAssessment[],
): GroupedDishAssessments {
  const grouped: GroupedDishAssessments = {
    menu_mentions: [],
    ai_inferred: [],
    unconfirmed: [],
  };

  for (const a of assessments) {
    if (a.category === "menu_mentions") {
      grouped.menu_mentions.push(a);
    } else if (a.category === "ai_inferred") {
      grouped.ai_inferred.push(a);
    } else {
      grouped.unconfirmed.push(a);
    }
  }

  return grouped;
}

/**
 * Organizes the entire menu response by each selected allergen so the user can review
 * how every dish relates to a specific allergen across the 3 categories.
 */
export function organizeResultsByAllergen(
  response: AnalyzeMenuResponse,
  selectedAllergens: readonly AllergenCode[],
): AllergenGroupedResult[] {
  return selectedAllergens.map((code) => {
    const group: AllergenGroupedResult = {
      code,
      menu_mentions: [],
      ai_inferred: [],
      unconfirmed: [],
    };

    for (const item of response.items) {
      const found = item.allergens.find((a) => a.code === code);
      const assessment: AllergenAssessment = found ?? {
        code,
        category: "unconfirmed",
        reason: "not_assessed",
        confirmationRequired: true,
      };

      if (assessment.category === "menu_mentions") {
        group.menu_mentions.push({ item, assessment });
      } else if (assessment.category === "ai_inferred") {
        group.ai_inferred.push({ item, assessment });
      } else {
        group.unconfirmed.push({ item, assessment });
      }
    }

    return group;
  });
}

export type PlainTextSegment = {
  text: string;
  highlighted: boolean;
};

/**
 * Splits `readText` into plain-text segments where occurrences of `excerpts` are marked
 * for emphasis using standard React text nodes (never HTML strings or dangerouslySetInnerHTML).
 */
export function splitTextByExcerpts(
  readText: string,
  excerpts: readonly string[],
): PlainTextSegment[] {
  const validExcerpts = excerpts
    .map((e) => e.trim())
    .filter((e) => e.length > 0);

  if (validExcerpts.length === 0 || readText.length === 0) {
    return [{ text: readText, highlighted: false }];
  }

  const lowerRead = readText.toLowerCase();
  const intervals: [number, number][] = [];

  for (const excerpt of validExcerpts) {
    const lowerExcerpt = excerpt.toLowerCase();
    let searchFrom = 0;
    while (searchFrom < lowerRead.length) {
      const idx = lowerRead.indexOf(lowerExcerpt, searchFrom);
      if (idx === -1) break;
      intervals.push([idx, idx + lowerExcerpt.length]);
      searchFrom = idx + Math.max(1, lowerExcerpt.length);
    }
  }

  if (intervals.length === 0) {
    return [{ text: readText, highlighted: false }];
  }

  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of intervals) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1]) {
      merged.push([start, end]);
    } else if (end > last[1]) {
      last[1] = end;
    }
  }

  const segments: PlainTextSegment[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) {
      segments.push({ text: readText.slice(cursor, start), highlighted: false });
    }
    segments.push({ text: readText.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < readText.length) {
    segments.push({ text: readText.slice(cursor), highlighted: false });
  }

  return segments;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
