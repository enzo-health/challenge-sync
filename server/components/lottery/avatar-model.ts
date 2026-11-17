// A member's saved avatar: the choices they made in the editor (app/me/avatar/page.tsx). The
// allowed values live in avatar-options.json, which the server also reads (src/avatar.rs) to
// validate a save, so the two can't drift. look.ts turns an avatar (or, for someone who never
// saved one, their generated default) into the Look the 3D characters are drawn from.
import options from "./avatar-options.json";

// TypeScript types a JSON import's strings as `string`, so the unions are spelled out here; the
// lists themselves (and their order) come from the JSON. A value the JSON gains without a matching
// union member still renders (every switch over these has a fallback) but won't typecheck where
// the editor labels it.
export type Hair =
  | "none" | "crew" | "buzz" | "sidepart" | "textured" | "receding" | "classicbob" | "shoulder" | "longdown" | "ponytail"
  | "bun" | "curly" | "bob" | "long" | "swoop" | "pigtails" | "spiky" | "mohawk";
export type FacialHair = "none" | "stubble" | "moustache" | "goatee" | "shortbeard" | "fullbeard";
export type Hat = "none" | "beanie" | "party" | "antenna" | "cap" | "bow" | "sprout";
export type Ears = "none" | "round" | "pointy";
export type Eyes = "dot" | "big" | "sleepy" | "happy" | "wink" | "starry";
export type Brows = "none" | "soft" | "arched" | "angry" | "worried" | "thick";
export type Nose = "none" | "button" | "pointy" | "round" | "snout";
export type Mouth = "smile" | "grin" | "smirk" | "o" | "flat" | "tooth";
/** "signature" is the proportions generated from the member id; the rest are fixed presets. */
export type Build = "signature" | "small" | "tall" | "round" | "lanky" | "bobble";

export interface AvatarSpec {
  v: 2;
  skin: string;
  outfit: string;
  accent: string;
  hairColor: string;
  hair: Hair;
  facialHair: FacialHair;
  hat: Hat;
  ears: Ears;
  eyes: Eyes;
  brows: Brows;
  nose: Nose;
  mouth: Mouth;
  build: Build;
}

export const AVATAR_OPTIONS = options as unknown as {
  version: 2;
  skin: readonly string[];
  outfit: readonly string[];
  accent: readonly string[];
  hairColor: readonly string[];
  hair: readonly Hair[];
  facialHair: readonly FacialHair[];
  hat: readonly Hat[];
  ears: readonly Ears[];
  eyes: readonly Eyes[];
  brows: readonly Brows[];
  nose: readonly Nose[];
  mouth: readonly Mouth[];
  build: readonly Build[];
};

/** Every field of an avatar except the version, in the order the editor shows them. */
export const AVATAR_FIELDS = [
  "skin", "eyes", "brows", "nose", "mouth", "ears", "hair", "facialHair", "hairColor", "build", "outfit", "hat", "accent",
] as const satisfies readonly (keyof AvatarSpec)[];
export type AvatarField = (typeof AVATAR_FIELDS)[number];

/**
 * The fixed builds: [height, girth, headSize], on the same scales as the generated proportions
 * (height 0.85..1.15, girth 0.9..1.15, headSize 0.9..1.2), each pushed clearly past one end.
 */
export const BUILD_PRESETS: Record<Exclude<Build, "signature">, readonly [number, number, number]> = {
  small: [0.74, 0.96, 1.12], // a little one: short, a touch big-headed
  tall: [1.24, 0.94, 0.96], // a head taller than most
  round: [0.9, 1.34, 1.02], // short and wide
  lanky: [1.3, 0.8, 0.88], // tall and thin, small head
  bobble: [0.84, 0.96, 1.42], // a bobblehead
};

/** Field-by-field equality (avatars are flat). */
export function sameAvatar(a: AvatarSpec, b: AvatarSpec): boolean {
  return AVATAR_FIELDS.every((k) => a[k] === b[k]) && a.v === b.v;
}

/**
 * An avatar as the API sends it (the generated client types every field as a plain string).
 * Version 1 avatars predate facial hair and have no `facialHair`.
 */
export type AvatarInput = { [K in Exclude<keyof AvatarSpec, "v" | "facialHair">]: string } & { v: number; facialHair?: string };

/**
 * Checks an avatar from the API against the options file: the avatar, or what is wrong with it
 * (field and value). A version 1 avatar (no facial hair yet) is upgraded with `facialHair: "none"`.
 * The server only stores valid avatars, so a failure means the page and the server disagree about
 * the options (e.g. a page older than the options file it is served with).
 */
export function parseAvatar(raw: AvatarInput | AvatarSpec): { avatar: AvatarSpec } | { error: string } {
  let input: Record<string, unknown> = { ...raw };
  if (raw.v === 1 && raw.facialHair === undefined) input = { ...input, v: 2, facialHair: "none" };
  else if (raw.v !== AVATAR_OPTIONS.version) return { error: `avatar version ${raw.v} (this page knows 1 and ${AVATAR_OPTIONS.version})` };
  for (const k of AVATAR_FIELDS) {
    const list = AVATAR_OPTIONS[k] as readonly unknown[];
    if (!list.includes(input[k])) return { error: `${k} "${String(input[k])}" is not one of this page's options` };
  }
  return { avatar: input as unknown as AvatarSpec };
}

/** A random avatar from the allowed values (the editor's Randomize), leaning toward everyday looks. */
export function randomAvatar(random: () => number = Math.random): AvatarSpec {
  const any = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  /** Mostly from the first `n` (the everyday end of the list), now and then anything. */
  const mostly = <T,>(list: readonly T[], n: number, odds = 0.75): T => (random() < odds ? list[Math.floor(random() * n)] : any(list));
  const o = AVATAR_OPTIONS;
  const everydayHair = o.hair.indexOf("bob") > 0 ? o.hair.indexOf("bob") : o.hair.length;
  return {
    v: 2,
    skin: any(o.skin),
    outfit: any(o.outfit),
    accent: any(o.accent),
    hairColor: mostly(o.hairColor, 7),
    hair: mostly(o.hair, everydayHair),
    // Most people are clean-shaven.
    facialHair: random() < 0.6 ? "none" : any(o.facialHair),
    hat: random() < 0.5 ? "none" : any(o.hat),
    ears: any(o.ears),
    eyes: mostly(o.eyes, 2, 0.5),
    brows: any(o.brows),
    nose: any(o.nose),
    mouth: any(o.mouth),
    build: random() < 0.5 ? "signature" : any(o.build),
  };
}
