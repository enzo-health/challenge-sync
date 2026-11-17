// Deterministic looks: every member gets the same little character every time, chosen from their
// id with a small seeded hash. Purely cosmetic; nothing here touches the draw.

/** A 32-bit integer hash (splitmix-style finaliser) of a member id plus a salt. */
export function hash32(id: number, salt = 0): number {
  let h = (Math.imul(id | 0, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca77)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** A stable number in [0, 1) for a member and a salt. */
export const unit = (id: number, salt: number) => hash32(id, salt) / 2 ** 32;

const pick = <T,>(list: readonly T[], id: number, salt: number): T => list[hash32(id, salt) % list.length];

/** Bright toy-box colours shared by the wheel slices and the characters. */
export const PARTY = [
  "#ff4d6d", // watermelon
  "#ffb703", // sunflower
  "#3a86ff", // sky blue
  "#2ec4b6", // lagoon
  "#8338ec", // grape
  "#fb5607", // tangerine
  "#06d6a0", // mint
  "#ff70a6", // bubblegum
] as const;

/** Wheel slice colours: the party palette in order, never two neighbours alike (incl. wrap-around). */
export function sliceColors(count: number): string[] {
  const colors: string[] = [];
  for (let i = 0; i < count; i++) colors.push(PARTY[i % PARTY.length]);
  if (count > 1 && colors[count - 1] === colors[0]) {
    // e.g. 9 slices: the last would match the first. Take a colour unlike either neighbour.
    colors[count - 1] = PARTY.find((c) => c !== colors[0] && c !== colors[count - 2]) ?? PARTY[2];
  }
  return colors;
}

const BODY = ["#ff4d6d", "#ffb703", "#3a86ff", "#2ec4b6", "#8338ec", "#fb5607", "#06d6a0", "#ff70a6", "#4cc9f0", "#f72585"];
// Heads are their own playful colours (these are toy creatures, not portraits of anyone).
const HEAD = ["#ffe8d6", "#fff3b0", "#ffd6e0", "#d8f3dc", "#e0e7ff", "#ffe5b4", "#f1e4ff", "#cdf5fd"];
const ACCENT = ["#ffffff", "#2b2d42", "#ffd166", "#ef476f", "#118ab2", "#06d6a0", "#ff9f1c"];

export type Hat = "none" | "beanie" | "party" | "antenna" | "cap" | "bow" | "sprout";
const HATS: readonly Hat[] = ["none", "beanie", "party", "antenna", "cap", "bow", "sprout", "party", "beanie"];
export type Ears = "none" | "round" | "pointy";
const EARS: readonly Ears[] = ["none", "none", "round", "pointy"];

/** How a non-winner on stage takes the result. */
export type Reaction = "cheer" | "clap" | "bummed";
const REACTIONS: readonly Reaction[] = ["cheer", "clap", "clap", "bummed", "cheer", "bummed"];

export interface Look {
  body: string;
  head: string;
  accent: string;
  hat: Hat;
  ears: Ears;
  /** Body proportions: 0.85 (short and round) .. 1.15 (tall). */
  height: number;
  /** 0.9 .. 1.15 */
  girth: number;
  /** 0.9 .. 1.2: the bigger the head, the more toy-like. */
  headSize: number;
  /** Eye spacing tweak, -1 .. 1. */
  eyeSpread: number;
  /** A phase offset so the idle animations don't move in lockstep. */
  phase: number;
  reaction: Reaction;
}

export function lookFor(memberId: number): Look {
  const body = pick(BODY, memberId, 1);
  let accent = pick(ACCENT, memberId, 3);
  if (accent === body) accent = "#ffffff";
  return {
    body,
    head: pick(HEAD, memberId, 2),
    accent,
    hat: pick(HATS, memberId, 4),
    ears: pick(EARS, memberId, 5),
    height: 0.85 + unit(memberId, 6) * 0.3,
    girth: 0.9 + unit(memberId, 7) * 0.25,
    headSize: 0.9 + unit(memberId, 8) * 0.3,
    eyeSpread: unit(memberId, 9) * 2 - 1,
    phase: unit(memberId, 10) * Math.PI * 2,
    reaction: pick(REACTIONS, memberId, 11),
  };
}

/** A muted take on a colour for the crowd off stage, so the stage reads first. */
export function muted(hex: string, amount = 0.45): string {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const grey = 0.3 * r + 0.59 * g + 0.11 * b;
  const toward = (c: number) => Math.round(c + (grey * 0.9 + 18 - c) * amount);
  return `#${[toward(r), toward(g), toward(b)].map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`;
}
