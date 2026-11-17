// Shared geometries, built once per page and reused by every character, star and confetti piece.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { FacialHair, Hair } from "./avatar-model";

let star: THREE.BufferGeometry | null = null;

/** A chunky, puffy five-point star about 1 unit across, facing +z. */
export function starGeometry(): THREE.BufferGeometry {
  if (star) return star;
  const shape = new THREE.Shape();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 0.5 : 0.23;
    const a = (i / (points * 2)) * Math.PI * 2;
    const x = Math.sin(a) * r;
    const y = Math.cos(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  star = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 3,
  });
  star.center();
  return star;
}

export interface CharacterGeometries {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  limb: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  pointyEar: THREE.BufferGeometry;
  cone: THREE.BufferGeometry;
  dome: THREE.BufferGeometry;
  brim: THREE.BufferGeometry;
  stalk: THREE.BufferGeometry;
  ball: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  crownBand: THREE.BufferGeometry;
  smile: THREE.BufferGeometry;
  frown: THREE.BufferGeometry;
  /** A thin arc for soft and arched brows (the upper half of a ring: an upside-down U). */
  browArc: THREE.BufferGeometry;
  /** A short horizontal stroke: straight brows, a flat mouth, a closed eye, teeth. */
  bar: THREE.BufferGeometry;
  /** The lower half of a sphere: squashed flat, a wide-open D-shaped grin. */
  grin: THREE.BufferGeometry;
  /** A short disc facing +z: a snout. */
  snout: THREE.BufferGeometry;
}

let character: CharacterGeometries | null = null;

export function characterGeometries(): CharacterGeometries {
  if (character) return character;
  character = {
    body: new THREE.CapsuleGeometry(0.3, 0.32, 8, 20),
    head: new THREE.SphereGeometry(0.36, 28, 20),
    limb: new THREE.CapsuleGeometry(0.075, 0.2, 4, 10),
    foot: new THREE.SphereGeometry(0.12, 16, 10),
    eye: new THREE.SphereGeometry(0.055, 12, 10),
    ear: new THREE.SphereGeometry(0.1, 14, 10),
    pointyEar: new THREE.ConeGeometry(0.09, 0.22, 12),
    cone: new THREE.ConeGeometry(0.2, 0.42, 20),
    dome: new THREE.SphereGeometry(0.37, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(0.4, 0.4, 0.05, 24),
    stalk: new THREE.CylinderGeometry(0.02, 0.02, 0.28, 6),
    ball: new THREE.SphereGeometry(0.075, 12, 10),
    ring: new THREE.TorusGeometry(0.55, 0.06, 12, 40),
    crownBand: new THREE.CylinderGeometry(0.24, 0.27, 0.16, 6, 1, true),
    smile: new THREE.TorusGeometry(0.09, 0.022, 8, 16, Math.PI),
    frown: new THREE.TorusGeometry(0.07, 0.02, 8, 16, Math.PI),
    browArc: new THREE.TorusGeometry(0.065, 0.017, 6, 14, Math.PI),
    bar: new THREE.CapsuleGeometry(0.019, 0.085, 4, 8).rotateZ(Math.PI / 2),
    grin: new THREE.SphereGeometry(0.1, 20, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
    snout: new THREE.CylinderGeometry(0.068, 0.074, 0.07, 20).rotateX(Math.PI / 2),
  };
  return character;
}

// --- hair ---------------------------------------------------------------------------------------
// Each style is ONE merged geometry in head space (the head is a 0.36 sphere at the origin, face
// toward +z), so a character's hair is one mesh on stage and the crowd draws each style in use as
// one instanced mesh (crowd-hair.tsx). Under a dome hat (beanie, cap) the "trimmed" variant drops
// the parts that would poke through the hat: spikes, fins, buns, the quiff, the top curls.

const UP = new THREE.Vector3(0, 1, 0);

/** A sphere cap: everything within `theta` of the top, tilted back by `tilt` so the hairline sits
 *  above the brows at the front and lower at the back. */
function cap(r: number, theta: number, tilt: number): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, 32, 14, 0, Math.PI * 2, 0, theta).rotateX(-tilt);
}

/** Unit direction `polar` radians from straight up, toward `azimuth` (0 = front, +x = π/2). */
function dir(polar: number, azimuth: number): THREE.Vector3 {
  return new THREE.Vector3(Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), Math.sin(polar) * Math.cos(azimuth));
}

/** `geometry` placed with its +y axis along `along`, centred at `at`, scaled. */
function placed(geometry: THREE.BufferGeometry, at: THREE.Vector3, along: THREE.Vector3 = UP, scale = new THREE.Vector3(1, 1, 1)): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(at, new THREE.Quaternion().setFromUnitVectors(UP, along.clone().normalize()), scale);
  return geometry.clone().applyMatrix4(m);
}

function at(x: number, y: number, z: number) {
  return new THREE.Vector3(x, y, z);
}

/** A band of a sphere around the back and sides, open over the face (±`open` radians of front). */
function wrap(r: number, open: number, from: number, to: number, rows = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, 36, rows, Math.PI / 2 + open, Math.PI * 2 - open * 2, from, to - from);
}

/** Short hair down the sides and back to ear level, so a cut frames the face (sits just under the
 *  cap, so only the temples and the nape show where the cap doesn't reach). */
function temples(r: number, open = 1.02, to = 1.74): THREE.BufferGeometry {
  return wrap(r - 0.006, open, 0.55, to);
}

/** Hair falling straight down round the sides and back (open over the face): an open-ended
 *  tapered tube from `yTop` to `yBottom`, flaring slightly, with a rolled hem. */
function curtain(rTop: number, rBottom: number, yTop: number, yBottom: number, open: number): THREE.BufferGeometry[] {
  const h = yTop - yBottom;
  const tube = new THREE.CylinderGeometry(rTop, rBottom, h, 40, 1, true, open, Math.PI * 2 - open * 2).translate(0, yBottom + h / 2, 0);
  // CylinderGeometry's angle runs from +z (the face) toward +x; the torus's from +x toward +y.
  const hem = new THREE.TorusGeometry(rBottom - 0.012, 0.035, 8, 40, Math.PI * 2 - open * 2)
    .rotateX(Math.PI / 2)
    .rotateY(-(open + Math.PI / 2))
    .translate(0, yBottom, 0);
  return [tube, hem];
}

/** A lock of hair: a capsule from `top` hanging `length` down (toward `along`), squashed in depth. */
function lock(radius: number, length: number, top: THREE.Vector3, along: THREE.Vector3, scale = new THREE.Vector3(1, 1, 0.7)): THREE.BufferGeometry {
  const down = along.clone().normalize();
  const centre = top.clone().addScaledVector(down, length / 2);
  return placed(new THREE.CapsuleGeometry(radius, length, 6, 14), centre, down.negate(), scale);
}

/**
 * How a piece fares under a hat: "base" always shows; "tall" pokes up, so it goes under a dome hat
 * (beanie, cap); "crown" sits right on top, so it also goes under a hat on a stalk (party,
 * antenna, sprout), which then stands on the head where it was.
 */
type Kind = "base" | "tall" | "crown";
export type HairFit = "full" | "dome" | "topper";
const KEEP: Record<HairFit, readonly Kind[]> = { full: ["base", "tall", "crown"], dome: ["base"], topper: ["base", "tall"] };

/** The pieces of each style. */
function hairPieces(style: Hair): [THREE.BufferGeometry, Kind][] {
  const sphere = (r: number) => new THREE.SphereGeometry(r, 16, 12);
  switch (style) {
    // --- everyday cuts ---------------------------------------------------------------------
    case "crew": {
      // Short all over, a little longer on top.
      const top = new THREE.SphereGeometry(0.392, 32, 8, 0, Math.PI * 2, 0, 0.82).rotateX(-0.32);
      return [[cap(0.374, 1.42, 0.48), "base"], [temples(0.374), "base"], [top, "tall"]];
    }
    case "sidepart": {
      // Short back and sides; the top combed over to one side from a part, a soft wave at the front.
      const sweep = placed(sphere(0.3), at(0.035, 0.24, 0.0), UP, new THREE.Vector3(1.04, 0.5, 1.06));
      const wave = placed(sphere(0.1), at(-0.05, 0.285, 0.215), new THREE.Vector3(-1, 0.25, 0.2), new THREE.Vector3(0.75, 1.9, 0.85));
      return [[cap(0.378, 1.4, 0.5), "base"], [temples(0.378), "base"], [sweep, "tall"], [wave, "tall"]];
    }
    case "textured": {
      // Tousled: soft lumps all over the top.
      const lump = sphere(0.085);
      const pieces: [THREE.BufferGeometry, Kind][] = [[cap(0.38, 1.38, 0.5), "base"], [temples(0.38), "base"]];
      const tilt = new THREE.Matrix4().makeRotationX(-0.38);
      const ring = (polar: number, count: number, offset: number, kind: Kind) => {
        for (let i = 0; i < count; i++) {
          const d = dir(polar, (i / count) * Math.PI * 2 + offset).applyMatrix4(tilt);
          pieces.push([placed(lump, d.clone().multiplyScalar(0.378), d, new THREE.Vector3(1.25, 0.6, 1.1)), kind]);
        }
      };
      ring(0, 1, 0, "crown");
      ring(0.42, 5, 0.3, "tall");
      ring(0.8, 8, 0, "tall");
      return pieces;
    }
    case "receding": {
      // The hairline has gone back from the forehead and temples: hair over the back of the top,
      // round the sides and the back; the forehead and the front of the crown are bare.
      return [[cap(0.376, 1.12, 0.92), "base"], [wrap(0.37, 1.3, 0.75, 1.86), "base"]];
    }
    case "classicbob": {
      // A neat chin-length bob: a side-swept fringe, smooth sides, the ends turned under.
      const shell = wrap(0.405, 1.12, 0.72, 1.92);
      const fringe = placed(sphere(0.12), at(-0.06, 0.27, 0.235), new THREE.Vector3(-1, 0.18, 0.35), new THREE.Vector3(0.7, 2.3, 0.75));
      const under = new THREE.TorusGeometry(0.365, 0.045, 8, 40, Math.PI * 2 - 2.3).rotateX(-Math.PI / 2).rotateY(-(Math.PI / 2 - 1.15)).translate(0, -0.14, 0);
      return [[cap(0.39, 1.36, 0.5), "base"], [shell, "base"], [fringe, "tall"], [under, "base"]];
    }
    case "shoulder": {
      // Shoulder length, worn down: framing the face, falling straight to the shoulders.
      const shell = wrap(0.41, 1.1, 0.7, Math.PI / 2);
      const [tube, hem] = curtain(0.41, 0.425, 0, -0.3, 1.1);
      return [[cap(0.39, 1.38, 0.5), "base"], [shell, "base"], [tube, "base"], [hem, "base"]];
    }
    case "longdown": {
      // Long and loose, well past the shoulders.
      const shell = wrap(0.412, 1.1, 0.7, Math.PI / 2);
      const [tube, hem] = curtain(0.412, 0.44, 0, -0.62, 1.1);
      return [[cap(0.39, 1.38, 0.5), "base"], [shell, "base"], [tube, "base"], [hem, "base"]];
    }
    case "ponytail": {
      // Pulled back smooth, tied at the back of the head, the tail falling behind.
      const tie = placed(sphere(0.055), at(0, 0.1, -0.385));
      const tail = lock(0.08, 0.3, at(0, 0.08, -0.43), new THREE.Vector3(0, -1, -0.32), new THREE.Vector3(1.15, 1, 0.95));
      return [[cap(0.384, 1.42, 0.5), "base"], [temples(0.384), "base"], [tie, "base"], [tail, "base"]];
    }
    // --- just for fun ---------------------------------------------------------------------
    case "buzz":
      return [[cap(0.369, 1.42, 0.48), "base"]];
    case "bob": {
      // A cap, plus a shell around the sides and back down to the chin, open at the face.
      const open = 1.08;
      const shell = new THREE.SphereGeometry(0.415, 32, 12, Math.PI / 2 + open, Math.PI * 2 - open * 2, 0.75, 1.27);
      return [[cap(0.388, 1.38, 0.50), "base"], [shell, "base"]];
    }
    case "spiky": {
      const spike = new THREE.ConeGeometry(0.08, 0.24, 10);
      const pieces: [THREE.BufferGeometry, Kind][] = [[cap(0.383, 1.32, 0.46), "base"]];
      pieces.push([placed(spike, dir(0.2, Math.PI).multiplyScalar(0.44), dir(0.2, Math.PI)), "crown"]);
      for (let i = 0; i < 7; i++) {
        const d = dir(0.72, (i / 7) * Math.PI * 2 + 0.2);
        pieces.push([placed(spike, d.clone().multiplyScalar(0.43), d), "tall"]);
      }
      return pieces;
    }
    case "mohawk": {
      // A row of flat fins from the forehead over to the back of the head.
      const fin = new THREE.ConeGeometry(0.1, 0.3, 12);
      const pieces: [THREE.BufferGeometry, Kind][] = [];
      [-0.62, -0.25, 0.12, 0.5, 0.88, 1.24].forEach((p, i) => {
        const d = dir(Math.abs(p), p < 0 ? 0 : Math.PI);
        const h = [0.75, 1, 1.12, 1.05, 0.9, 0.7][i];
        pieces.push([placed(fin, d.clone().multiplyScalar(0.36 + 0.1 * h), d, new THREE.Vector3(0.55, h, 1)), Math.abs(p) < 0.4 ? "crown" : "tall"]);
      });
      return pieces;
    }
    case "bun": {
      const d = dir(0.5, Math.PI);
      return [[cap(0.385, 1.38, 0.50), "base"], [placed(sphere(0.14), d.multiplyScalar(0.44)), "tall"]];
    }
    case "pigtails": {
      const pieces: [THREE.BufferGeometry, Kind][] = [[cap(0.385, 1.38, 0.50), "base"]];
      for (const side of [-1, 1]) {
        const out = new THREE.Vector3(side, -0.55, -0.25).normalize();
        pieces.push([placed(sphere(0.1), at(side * 0.43, 0.02, -0.1), out, new THREE.Vector3(0.95, 1.7, 0.95)), "base"]);
        pieces.push([placed(sphere(0.05), at(side * 0.355, 0.11, -0.07)), "base"]);
      }
      return pieces;
    }
    case "curly": {
      // A cloud of puffs over the scalp.
      const puff = sphere(0.12);
      const pieces: [THREE.BufferGeometry, Kind][] = [[cap(0.38, 1.4, 0.50), "base"]];
      const tilt = new THREE.Matrix4().makeRotationX(-0.5);
      const ring = (polar: number, count: number, skipFront: number, kind: Kind) => {
        for (let i = 0; i < count; i++) {
          const az = (i / count) * Math.PI * 2;
          const front = Math.abs(Math.atan2(Math.sin(az), Math.cos(az)));
          if (front < skipFront) continue;
          const d = dir(polar, az).applyMatrix4(tilt);
          pieces.push([placed(puff, d.multiplyScalar(0.37)), kind]);
        }
      };
      ring(0, 1, 0, "crown");
      ring(0.55, 6, 0, "tall");
      ring(1.05, 10, 0.5, "tall");
      ring(1.5, 8, 1.3, "base");
      return pieces;
    }
    case "swoop": {
      // A big quiff sweeping over the forehead to one side.
      const quiff = placed(sphere(0.1), at(0.07, 0.31, 0.19), new THREE.Vector3(-0.9, 0.35, 0.25), new THREE.Vector3(1.1, 2.4, 1.3));
      const tip = placed(sphere(0.07), at(-0.13, 0.27, 0.24), new THREE.Vector3(-1, 0.1, 0.4), new THREE.Vector3(1, 1.7, 1));
      return [[cap(0.385, 1.38, 0.50), "base"], [quiff, "tall"], [tip, "tall"]];
    }
    case "long": {
      // A cap, a shell from the temples round the back, and a curtain down to the shoulders.
      const wrap = 1.78;
      const shell = new THREE.SphereGeometry(0.408, 32, 12, (Math.PI * 3) / 2 - wrap, wrap * 2, 0.7, 1.55);
      const curtain = placed(new THREE.CapsuleGeometry(0.2, 0.34, 6, 16), at(0, -0.3, -0.2), new THREE.Vector3(0, 1, 0.12), new THREE.Vector3(1.5, 1, 0.55));
      return [[cap(0.39, 1.38, 0.50), "base"], [shell, "base"], [curtain, "base"]];
    }
    default:
      return [];
  }
}

const hairCache = new Map<string, THREE.BufferGeometry | null>();

/** The merged geometry for a hair style (null for "none"), built once per page and variant. */
export function hairGeometry(style: Hair, fit: HairFit = "full"): THREE.BufferGeometry | null {
  const key = `${style}:${fit}`;
  if (hairCache.has(key)) return hairCache.get(key) ?? null;
  const parts = hairPieces(style)
    .filter(([, kind]) => KEEP[fit].includes(kind))
    .map(([geometry]) => geometry);
  const merged = parts.length ? mergeGeometries(parts) : null;
  for (const p of parts) p.dispose();
  hairCache.set(key, merged);
  return merged;
}

/** How high a hat on a stalk stands on each style (its "crown" pieces are cleared away). */
export const HAIR_LIFT: Record<Hair, number> = {
  crew: 0.03, sidepart: 0.04, textured: 0.03, receding: 0, classicbob: 0.03, shoulder: 0.03, longdown: 0.03, ponytail: 0.024,
  none: 0, buzz: 0.01, bob: 0.03, spiky: 0.03, mohawk: 0, bun: 0.02, pigtails: 0.025, curly: 0.07, swoop: 0.04, long: 0.03,
};

/** How far each style rises above the top of the head (head units), for hats, crowns and tags. */
export const HAIR_TOP: Record<Hair, number> = {
  crew: 0.035, sidepart: 0.06, textured: 0.07, receding: 0, classicbob: 0.04, shoulder: 0.05, longdown: 0.052, ponytail: 0.024,
  none: 0, buzz: 0.01, bob: 0.055, spiky: 0.2, mohawk: 0.24, bun: 0.15, pigtails: 0.025, curly: 0.13, swoop: 0.1, long: 0.03,
};

// --- facial hair --------------------------------------------------------------------------------
// Head space too, kept clear of the mouth (y -0.04 .. -0.17 at the middle of the face) and the
// cheeks' blush, so every mouth (and the sad frown) still shows. With a snout the moustache parts
// round it. One merged geometry per style, like the hair.

function moustache(scale: number, apart: number): THREE.BufferGeometry[] {
  // Two plump halves under the nose, drooping a little toward the corners of the mouth.
  return [-1, 1].map((side) =>
    placed(
      new THREE.SphereGeometry(0.05, 14, 10),
      at(side * (0.052 + apart) * scale, -0.027, 0.352),
      new THREE.Vector3(side, -0.32, 0.08),
      new THREE.Vector3(0.52 * scale, 1.45 * scale, 0.75),
    ),
  );
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * A beard: a pillow-shaped patch on the head sphere, `half` radians either side of the face,
 * between `top(φ)` and `bottom(φ)` (angles from straight up), lying flush at its edges and
 * `thick(φ)` proud in the middle, so it sits on the face rather than floating over it.
 */
function beard(half: number, top: (phi: number) => number, bottom: (phi: number) => number, thick: (phi: number) => number, base = 0.362): THREE.BufferGeometry {
  const cols = 40;
  const rows = 12;
  const position: number[] = [];
  const uv: number[] = [];
  const index: number[] = [];
  for (let i = 0; i <= cols; i++) {
    const u = i / cols;
    const phi = -half + u * half * 2;
    for (let j = 0; j <= rows; j++) {
      const v = j / rows;
      const polar = top(phi) + (bottom(phi) - top(phi)) * v;
      // Thickest in the middle, flush at every edge (the ends taper too).
      const ends = smooth(half, half - 0.18, Math.abs(phi));
      const r = base + thick(phi) * Math.sin(Math.PI * v) ** 0.6 * (0.25 + 0.75 * ends);
      position.push(r * Math.sin(polar) * Math.sin(phi), r * Math.cos(polar), r * Math.sin(polar) * Math.cos(phi));
      uv.push(u, v);
    }
  }
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const a = i * (rows + 1) + j;
      const b = a + rows + 1;
      index.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** The top of a beard: under the mouth at the front, rising past the cheeks to sideburns in front
 *  of the ears. */
const jawTop = (lift: number) => (phi: number) =>
  2.06 - lift * smooth(0.3, 0.95, Math.abs(phi)) - 0.16 * smooth(1.15, 1.55, Math.abs(phi));
/** The bottom: under the chin at the front, climbing the jaw so the sideburn ends as a strip. */
const jawBottom = (depth: number, lift: number, half: number) => (phi: number) => {
  const top = jawTop(lift)(phi);
  return depth - (depth - top - 0.3) * smooth(0.55, half, Math.abs(phi));
};

function facialPieces(style: FacialHair, snout: boolean): THREE.BufferGeometry[] {
  const apart = snout ? 0.035 : 0;
  switch (style) {
    case "stubble":
      // A shadow over the jaw and chin (drawn see-through: see avatar.tsx).
      return [beard(1.5, jawTop(0.5), jawBottom(2.72, 0.5, 1.5), () => 0.004)];
    case "moustache":
      return moustache(1, apart);
    case "goatee": {
      const chin = beard(0.42, () => 2.08, () => 2.72, (phi) => 0.03 + 0.025 * Math.cos(phi * 3));
      return [chin, ...moustache(0.82, apart)];
    }
    case "shortbeard":
      return [beard(1.5, jawTop(0.58), jawBottom(2.8, 0.58, 1.5), () => 0.028), ...moustache(0.95, apart)];
    case "fullbeard":
      return [beard(1.58, jawTop(0.66), jawBottom(3.0, 0.66, 1.58), (phi) => 0.05 + 0.055 * Math.cos(phi) ** 2), ...moustache(1.12, apart)];
    default:
      return [];
  }
}

const facialCache = new Map<string, THREE.BufferGeometry | null>();

/** The merged geometry for a facial hair style (null for "none"). */
export function facialHairGeometry(style: FacialHair, snout = false): THREE.BufferGeometry | null {
  const key = `${style}:${snout}`;
  if (facialCache.has(key)) return facialCache.get(key) ?? null;
  const parts = facialPieces(style, snout);
  const merged = parts.length ? mergeGeometries(parts) : null;
  for (const p of parts) p.dispose();
  facialCache.set(key, merged);
  return merged;
}
