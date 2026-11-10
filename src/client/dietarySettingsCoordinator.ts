import { sanitizeDietarySettings, type DietarySettings } from "./dietarySettingsStorage";

type Snapshot = { settings: DietarySettings; revision: number };
type Result = { ok: boolean; settings: DietarySettings; revision?: number };

/** One coordinator per mounted app. Generations cover errors and temporary mode,
 * where no durable revision exists. A newer observation invalidates every older
 * completion, including initial restoration and failed saves/deletes.
 */
export class DietarySettingsCoordinator {
  private generation = 0;
  private revision = -1;
  constructor(private settings: DietarySettings) {}

  begin(): number { return ++this.generation; }
  checkpoint(): number { return this.generation; }
  invalidate(): void { this.generation += 1; }

  restore(snapshot: Snapshot, generation: number): DietarySettings | null {
    if (generation !== this.generation || snapshot.revision < this.revision) return null;
    return this.adopt(snapshot.settings, snapshot.revision);
  }

  synchronize(snapshot: Snapshot): DietarySettings | null {
    if (snapshot.revision <= this.revision) return null;
    return this.adopt(snapshot.settings, snapshot.revision);
  }

  complete(generation: number, result: Result,
    intent: (current: DietarySettings) => DietarySettings): DietarySettings | null {
    if (generation !== this.generation) return null;
    if (result.revision !== undefined) {
      if (!Number.isSafeInteger(result.revision) || result.revision < 0 || result.revision < this.revision) return null;
      return this.adopt(result.ok ? result.settings : intent(result.settings), result.revision);
    }
    // A successful browser write must carry its committed canonical revision.
    // A failure without a canonical observation may only apply the explicit
    // intent to the current UI state, never its stale settings payload.
    if (result.ok) return null;
    return this.adopt(sanitizeDietarySettings(intent(this.settings)), this.revision);
  }

  private adopt(settings: DietarySettings, revision: number): DietarySettings {
    this.settings = sanitizeDietarySettings(settings);
    this.revision = revision;
    this.generation += 1;
    return this.settings;
  }
}
