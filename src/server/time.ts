/*
 * The ONE validation boundary for clock values used by the cost guards
 * (PR #5 audit, MAJOR-2).
 *
 * A comparison with NaN is always false, and ±Infinity passes "<" / ">" checks
 * in surprising directions, so an unchecked clock can silently skip a deadline
 * or permit check. Every time value the runner and the usage guard act on
 * (clock reads, deadlines, permit expiries) goes through `isValidTimeMs`:
 *  - a safe INTEGER number of epoch milliseconds (Date.now() returns integers),
 *  - within the ECMAScript Date range [0, 8.64e15].
 * Anything else is invalid and the caller fails closed (no store call, no
 * model call).
 */

/** Largest valid time value (ECMAScript Date range). */
export const MAX_TIME_MS = 8_640_000_000_000_000;

export function isValidTimeMs(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_TIME_MS;
}

/** Thrown by `readTime` for an invalid clock value. Carries no value. */
export class ClockError extends Error {
  constructor() {
    super("invalid clock value");
    this.name = "ClockError";
  }
}

/** Reads the clock and returns a valid time, or throws ClockError (also when the clock itself throws). */
export function readTime(now: () => number): number {
  let t: unknown;
  try {
    t = now();
  } catch {
    throw new ClockError();
  }
  if (!isValidTimeMs(t)) throw new ClockError();
  return t;
}

/** Like `readTime`, but returns undefined instead of throwing. */
export function tryReadTime(now: () => number): number | undefined {
  try {
    return readTime(now);
  } catch {
    return undefined;
  }
}
