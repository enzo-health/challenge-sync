// Deterministic looks: every member gets the same little character every time, chosen from their
// id with a small seeded hash, unless they designed their own in the avatar editor. Purely
// cosmetic; nothing here touches the draw.
import {
  AVATAR_OPTIONS, BUILD_PRESETS, parseAvatar,
  type AvatarInput, type AvatarSpec, type Brows, type Ears, type Eyes, type FacialHair, type Hair, type Hat, type Mouth, type Nose,
} from "./avatar-model";

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

// Today's palettes are the first entries of the editor's lists (avatar-options.json), in the same
// order, so everyone who never saved an avatar keeps exactly the character they always had.
const BODY = AVATAR_OPTIONS.outfit;
// Heads are their own playful colours (these are toy creatures, not portraits of anyone). The
// editor offers a few more skin tones after these; the generated look only picks from the first 8.
const HEAD = AVATAR_OPTIONS.skin.slice(0, 8);
const ACCENT = AVATAR_OPTIONS.accent;

export type { Ears, Hat } from "./avatar-model";
// Weighted: some hats come up more often than others.
const HATS: readonly Hat[] = ["none", "beanie", "party", "antenna", "cap", "bow", "sprout", "party", "beanie"];
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
  /** Body proportions: 0.85 (short and round) .. 1.15 (tall) when generated; see BUILD_PRESETS. */
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
  // The face and hair, from the avatar editor (the generated defaults are today's face, bald).
  hair: Hair;
  facialHair: FacialHair;
  hairColor: string;
  eyes: Eyes;
  brows: Brows;
  nose: Nose;
  mouth: Mouth;
}

/**
 * The avatar someone has until they save their own: today's generated character (the same skin,
 * outfit, accent, hat and ears picks as ever, a dot-eyed smile, no hair) on their signature build.
 */
export function defaultAvatar(memberId: number): AvatarSpec {
  const outfit = pick(BODY, memberId, 1);
  let accent = pick(ACCENT, memberId, 3);
  if (accent === outfit) accent = "#ffffff";
  return {
    v: 2,
    skin: pick(HEAD, memberId, 2),
    outfit,
    accent,
    hairColor: pick(AVATAR_OPTIONS.hairColor, memberId, 12),
    hair: "none",
    facialHair: "none",
    hat: pick(HATS, memberId, 4),
    ears: pick(EARS, memberId, 5),
    eyes: "dot",
    brows: "none",
    nose: "none",
    mouth: "smile",
    build: "signature",
  };
}

/**
 * How a member looks on stage: their saved avatar, or their generated default when they have none.
 * Eye spacing, animation phase and how they take the result are personality, always from the id.
 */
export function resolveLook(memberId: number, avatar: AvatarSpec | AvatarInput | null | undefined): Look {
  let a = defaultAvatar(memberId);
  if (avatar) {
    const parsed = parseAvatar(avatar);
    if ("avatar" in parsed) a = parsed.avatar;
    else reportBadAvatar(memberId, parsed.error);
  }
  const [height, girth, headSize] =
    a.build === "signature"
      ? [0.85 + unit(memberId, 6) * 0.3, 0.9 + unit(memberId, 7) * 0.25, 0.9 + unit(memberId, 8) * 0.3]
      : BUILD_PRESETS[a.build];
  return {
    body: a.outfit,
    head: a.skin,
    accent: a.accent,
    hat: a.hat,
    ears: a.ears,
    height,
    girth,
    headSize,
    eyeSpread: unit(memberId, 9) * 2 - 1,
    phase: unit(memberId, 10) * Math.PI * 2,
    reaction: pick(REACTIONS, memberId, 11),
    hair: a.hair,
    facialHair: a.facialHair,
    hairColor: a.hairColor,
    eyes: a.eyes,
    brows: a.brows,
    nose: a.nose,
    mouth: a.mouth,
  };
}

const reported = new Set<string>();
/** A saved avatar this page can't draw: the member keeps their generated look, and the console says why (once). */
function reportBadAvatar(memberId: number, error: string) {
  const key = `${memberId}:${error}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`Member ${memberId}'s saved avatar can't be drawn (${error}); showing their generated look instead.`);
}

/** The generated look of someone with no saved avatar. */
export const lookFor = (memberId: number): Look => resolveLook(memberId, null);

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
