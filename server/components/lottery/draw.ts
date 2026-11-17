// The weekly draw's arithmetic, kept pure so it can be read (and tested) on its own.
//
// Fairness: the winner is picked here, BEFORE the wheel moves, with one uniform draw over the
// entrants: one entry per person, whatever their post count. The wheel animation is then aimed at
// that pick; nothing about the animation can change who won.

/** Fills `buf` with random 32-bit words. The default is the browser's CSPRNG. */
export type RandomWords = (buf: Uint32Array) => Uint32Array;

const cryptoWords: RandomWords = (buf) => crypto.getRandomValues(buf);

const WORD_RANGE = 2 ** 32;

/**
 * A uniform random integer in [0, n).
 *
 * Rejection sampling: a 32-bit word is accepted only below the largest multiple of n that fits in
 * 2^32, so every residue mod n is backed by exactly the same number of accepted words (no modulo
 * bias). For n <= 2^31 more than half of all words are accepted, so the loop ends almost at once.
 */
export function uniformIndex(n: number, randomWords: RandomWords = cryptoWords): number {
  if (!Number.isInteger(n) || n < 1 || n > WORD_RANGE) {
    throw new RangeError(`uniformIndex needs a whole number of choices between 1 and 2^32, got ${n}`);
  }
  const limit = WORD_RANGE - (WORD_RANGE % n);
  const buf = new Uint32Array(1);
  for (;;) {
    randomWords(buf);
    const word = buf[0];
    if (word < limit) return word % n;
  }
}

/** Pick the winning position in `entrants` (uniform, one entry each). Throws on an empty list. */
export function drawWinnerIndex(entrants: readonly unknown[], randomWords: RandomWords = cryptoWords): number {
  if (entrants.length === 0) throw new RangeError("Nobody to draw from");
  return uniformIndex(entrants.length, randomWords);
}

// --- wheel geometry --------------------------------------------------------------------------
//
// Angles are measured CLOCKWISE from the top of the wheel, as the viewer sees it. Slice i covers
// [i * slice, (i + 1) * slice). The wheel's rotation `theta` follows three.js (counter-clockwise
// positive about the axis pointing at the viewer), so a clockwise spin makes theta go DOWN.
// With the pointer fixed at the top, the wheel-local angle under it is theta (mod a full turn).

export const TAU = Math.PI * 2;

const mod = (a: number, m: number) => ((a % m) + m) % m;

export const sliceAngle = (count: number) => TAU / count;

/** Which slice sits under the top pointer when the wheel is at rotation `theta`. */
export function sliceUnderPointer(theta: number, count: number): number {
  return Math.min(count - 1, Math.floor(mod(theta, TAU) / sliceAngle(count)));
}

/**
 * The rotation to stop at so the pointer lands inside slice `index`, after spinning clockwise
 * from `from` through `extraTurns` whole turns plus whatever is needed to reach the slice.
 *
 * `offset` places the stop within the slice: 0 is dead centre, -1 and 1 would be its edges. It is
 * clamped to +-0.7 so the pointer never sits on a divider, where a viewer could argue about it.
 */
export function landingRotation(from: number, index: number, count: number, extraTurns: number, offset = 0): number {
  const slice = sliceAngle(count);
  const within = Math.max(-0.7, Math.min(0.7, offset));
  const target = (index + 0.5 + within * 0.5) * slice;
  const toTarget = mod(from - target, TAU); // clockwise distance from here to the target, < 1 turn
  return from - toTarget - Math.max(0, Math.round(extraTurns)) * TAU;
}

// --- easing ----------------------------------------------------------------------------------

export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

export interface SpinPlan {
  from: number;
  to: number;
  /** Total length in seconds, including the wind-up. */
  duration: number;
  /** Seconds spent pulling back before the spin (0 for none). */
  windup: number;
  /** How far the wind-up pulls back, in radians (counter-clockwise). */
  windupAngle: number;
}

/** The wheel's rotation `elapsed` seconds into a spin. Ends exactly on `plan.to`. */
export function spinRotation(plan: SpinPlan, elapsed: number): number {
  const { from, to, duration, windup, windupAngle } = plan;
  if (elapsed >= duration) return to;
  if (windup > 0 && elapsed < windup) {
    // A cheeky pull-back before the big push.
    return from + windupAngle * Math.sin((elapsed / windup) * (Math.PI / 2));
  }
  const start = from + (windup > 0 ? windupAngle : 0);
  const t = (elapsed - windup) / (duration - windup);
  return start + (to - start) * easeOutQuint(t);
}

/** 0 at the start of the spin, 1 when the wheel has stopped. */
export const spinProgress = (plan: SpinPlan, elapsed: number) => Math.min(1, Math.max(0, elapsed / plan.duration));
