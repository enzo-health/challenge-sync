// Where everybody in the plaza is, frame by frame: a plain mutable model (no React, no three.js)
// that the scene steps once per frame and the renderers read. Everyone on the roster is in it:
//
//   - "wander": not connected to the room. They pick a nearby spot (from a seeded hash of their
//     id, so a member wanders the same way on every screen and every load), bounce over to it,
//     loiter, now and then hop on the spot, and pick the next.
//   - "online": connected. They ease toward the latest position the room relayed (positions come
//     about ten times a second), so they glide instead of stepping; their first appearance places
//     them directly.
//   - "me": the viewer, moved by the keyboard right away (the room is told afterwards).
//
// Coordinates: the room's world is 2000 x 1200 units (plaza-protocol/src/lib.rs); the scene's
// ground plane is that world scaled by SCALE and centred on the origin, room x -> scene x and
// room y -> scene z.
import { hop } from "../lottery/avatar";

export const WORLD_W = 2000;
export const WORLD_H = 1200;
/** Scene units per world unit: the 140-unit high-five reach is about two characters apart. */
export const SCALE = 0.012;
export const HALF_W = (WORLD_W / 2) * SCALE;
export const HALF_D = (WORLD_H / 2) * SCALE;

export const toScene = (x: number, y: number) => ({ x: (x - WORLD_W / 2) * SCALE, z: (y - WORLD_H / 2) * SCALE });
export const toWorld = (x: number, z: number) => ({ x: x / SCALE + WORLD_W / 2, y: z / SCALE + WORLD_H / 2 });
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** A stable number in [0, 1) from an id and two salts. */
function rand(id: number, a: number, b: number): number {
  let h = (Math.imul(id | 0, 0x9e3779b1) ^ Math.imul(a + 1, 0x85ebca77) ^ Math.imul(b + 7, 0xc2b2ae3d)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 2 ** 32;
}

/** How long a chat bubble stays up: about 5 s, longer messages a little longer (up to 9 s). */
export function bubbleSeconds(text: string): number {
  return clamp(3.6 + 0.07 * [...text].length, 5, 9);
}

export const JUMP_SECONDS = 0.62;
const JUMP_HEIGHT = 0.62;
const HIGH_FIVE_SECONDS = 1.5;
const WALK_SPEED = 3.4;
/** Wanderers stay this far inside the plaza's edge. */
const MARGIN = 0.6;

export type Mode = "wander" | "online" | "me";

export interface Person {
  id: number;
  name: string;
  posted: boolean;
  /** Position in the roster (the instanced crowd's slot). */
  index: number;
  mode: Mode;
  x: number;
  z: number;
  /** Facing: 0 looks at the camera (+z). */
  yaw: number;
  /** Ground speed this frame (scene units per second), for the walk animation. */
  speed: number;
  /** Where they are heading: a wander spot, or the room's latest position for them. */
  tx: number;
  tz: number;
  /** Wanderers: seconds left loitering before the next spot; `seq` counts the spots. */
  wait: number;
  seq: number;
  walk: number;
  jumpAt: number;
  fiveAt: number;
  fivePartner: number | null;
  bubble: string | null;
  bubbleUntil: number;
  /** This frame's pose, for both renderers. */
  lift: number;
  stretch: number;
}

export interface Burst {
  a: number;
  b: number;
  at: number;
  key: number;
}

export interface RosterEntry {
  id: number;
  name: string;
  posted: boolean;
}

export class PlazaSim {
  /** Seconds since the plaza opened. */
  t = 0;
  readonly people: Person[];
  readonly byId = new Map<number, Person>();
  readonly meId: number;
  reducedMotion = false;
  /** The keyboard's direction this frame (x right, z toward the camera), set by the page. */
  input = { x: 0, z: 0 };
  bursts: Burst[] = [];
  highFives = 0;
  private burstKey = 0;

  constructor(members: RosterEntry[], meId: number) {
    this.meId = meId;
    this.people = [];
    this.upsert(members);
  }

  /**
   * The roster as (re)loaded: names and stars change in place, newcomers start wandering. Nobody is
   * moved and nobody is removed (someone deleted meanwhile just keeps wandering until a reload).
   * Returns whether anyone was added.
   */
  upsert(members: RosterEntry[]): boolean {
    let added = false;
    for (const m of members) {
      const p = this.byId.get(m.id);
      if (p) {
        p.name = m.name;
        p.posted = m.posted;
      } else {
        this.add(m);
        added = true;
      }
    }
    return added;
  }

  /**
   * Someone the room knows and the loaded roster doesn't (they joined since it loaded): they get a
   * slot now, nameless, and the page fetches the roster for their name and look.
   */
  ensure(id: number): Person {
    return this.byId.get(id) ?? this.add({ id, name: "", posted: false });
  }

  private add(m: RosterEntry): Person {
    const me = m.id === this.meId;
    // Wanderers start scattered over the plaza; you start near the middle.
    const x = me ? (rand(m.id, 1, 0) - 0.5) * 2 : (rand(m.id, 1, 0) * 2 - 1) * (HALF_W - MARGIN);
    const z = me ? 1 + rand(m.id, 2, 0) : (rand(m.id, 2, 0) * 2 - 1) * (HALF_D - MARGIN);
    const p: Person = {
      id: m.id, name: m.name, posted: m.posted, index: this.people.length, mode: me ? "me" : "wander",
      x, z, yaw: 0, speed: 0, tx: x, tz: z, wait: rand(m.id, 3, 0) * 2, seq: 0, walk: rand(m.id, 4, 0),
      jumpAt: -1e9, fiveAt: -1e9, fivePartner: null, bubble: null, bubbleUntil: 0, lift: 0, stretch: 1,
    };
    this.people.push(p);
    this.byId.set(m.id, p);
    return p;
  }

  get me(): Person | undefined {
    return this.byId.get(this.meId);
  }

  /** The room says `id` is here (welcome or join). The first appearance places them directly. */
  appear(id: number, x: number, y: number) {
    const p = this.ensure(id);
    if (p.mode === "me") return;
    const at = toScene(x, y);
    p.mode = "online";
    p.x = p.tx = at.x;
    p.z = p.tz = at.z;
    p.speed = 0;
  }

  moveTo(id: number, x: number, y: number) {
    const p = this.ensure(id);
    if (p.mode === "me") return;
    if (p.mode === "wander") return this.appear(id, x, y);
    const at = toScene(x, y);
    p.tx = at.x;
    p.tz = at.z;
  }

  /** Back to wandering, from where they stand. */
  leave(id: number) {
    const p = this.byId.get(id);
    if (!p || p.mode !== "online") return;
    p.mode = "wander";
    p.tx = p.x;
    p.tz = p.z;
    p.wait = 1 + rand(id, 5, p.seq);
  }

  /** Everyone online goes back to wandering (the connection ended). */
  allLeave() {
    for (const p of this.people) if (p.mode === "online") this.leave(p.id);
  }

  canJump(id: number): boolean {
    const p = this.byId.get(id);
    return !!p && this.t - p.jumpAt >= JUMP_SECONDS;
  }

  jump(id: number) {
    const p = this.byId.get(id);
    if (p && this.canJump(id)) p.jumpAt = this.t;
  }

  highFive(a: number, b: number) {
    const pa = this.byId.get(a);
    const pb = this.byId.get(b);
    if (!pa || !pb) return;
    for (const [p, q] of [[pa, pb], [pb, pa]] as const) {
      p.fiveAt = this.t;
      p.fivePartner = q.id;
    }
    this.highFives += 1;
    this.bursts.push({ a, b, at: this.t, key: ++this.burstKey });
  }

  say(id: number, text: string) {
    const p = this.ensure(id);
    p.bubble = text;
    p.bubbleUntil = this.t + bubbleSeconds(text);
  }

  /** My position in room units. */
  myWorld(): { x: number; y: number } | null {
    const me = this.me;
    if (!me) return null;
    const w = toWorld(me.x, me.z);
    return { x: clamp(w.x, 0, WORLD_W), y: clamp(w.y, 0, WORLD_H) };
  }

  step(dt: number) {
    dt = Math.min(dt, 0.1); // a background tab coming back must not fling anyone across the plaza
    this.t += dt;
    const t = this.t;
    for (const p of this.people) {
      const ox = p.x;
      const oz = p.z;
      if (p.mode === "me") this.stepMe(p, dt);
      else if (p.mode === "online") {
        const k = 1 - Math.exp(-9 * dt);
        p.x += (p.tx - p.x) * k;
        p.z += (p.tz - p.z) * k;
      } else this.stepWander(p, dt);
      const dx = p.x - ox;
      const dz = p.z - oz;
      const moved = Math.hypot(dx, dz);
      p.speed = dt > 0 ? moved / dt : 0;

      // Facing: where they walk; a high five turns them to their partner; idle, back to the camera.
      let want: number | null = null;
      const partner = p.fivePartner !== null && t - p.fiveAt < HIGH_FIVE_SECONDS ? this.byId.get(p.fivePartner) : undefined;
      if (partner) want = Math.atan2(partner.x - p.x, partner.z - p.z);
      else if (p.speed > 0.15) want = Math.atan2(dx, dz);
      else if (p.speed < 0.02) want = 0;
      if (want !== null) {
        let d = want - p.yaw;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        p.yaw += d * (1 - Math.exp(-(partner ? 14 : p.speed > 0.15 ? 12 : 2.5) * dt));
      }

      // Pose: a jump, or a bouncy walk (wanderers bounce more: they are just bouncing around).
      let lift = 0;
      let stretch = 1;
      const j = (t - p.jumpAt) / JUMP_SECONDS;
      if (j >= 0 && j < 1) {
        const h = hop(j);
        lift = h.lift * JUMP_HEIGHT;
        stretch = h.stretch;
      } else if (p.speed > 0.2 && !this.reducedMotion) {
        p.walk += dt * (p.mode === "wander" ? 2.4 : 1.2 + p.speed * 0.45);
        const h = hop(p.walk % 1);
        lift = h.lift * (p.mode === "wander" ? 0.16 : 0.07);
        stretch = 1 + (h.stretch - 1) * 0.6;
      } else if (!this.reducedMotion) {
        stretch = 1 + 0.03 * Math.sin(t * 2.2 + p.index);
      }
      p.lift = lift;
      p.stretch = stretch;
      if (p.bubble && t > p.bubbleUntil) p.bubble = null;
    }
    if (this.bursts.length && t - this.bursts[0].at > HIGH_FIVE_SECONDS) this.bursts = this.bursts.filter((b) => t - b.at <= HIGH_FIVE_SECONDS);
  }

  /** Whether `p` is mid high five, and with whom. */
  fiving(p: Person): Person | undefined {
    return p.fivePartner !== null && this.t - p.fiveAt < HIGH_FIVE_SECONDS ? this.byId.get(p.fivePartner) : undefined;
  }

  private stepMe(p: Person, dt: number) {
    const { x, z } = this.input;
    const len = Math.hypot(x, z);
    if (len > 0) {
      p.x = clamp(p.x + (x / len) * WALK_SPEED * dt, -HALF_W, HALF_W);
      p.z = clamp(p.z + (z / len) * WALK_SPEED * dt, -HALF_D, HALF_D);
    }
  }

  private stepWander(p: Person, dt: number) {
    if (p.wait > 0) {
      p.wait -= dt;
      return;
    }
    const dx = p.tx - p.x;
    const dz = p.tz - p.z;
    const d = Math.hypot(dx, dz);
    const speed = 0.8 + rand(p.id, 6, 0) * 0.6;
    if (d < 0.05) {
      p.seq += 1;
      p.wait = 0.8 + rand(p.id, 7, p.seq) * 3.2;
      // Now and then a hop on the spot while loitering (a jump that starts mid-wait).
      if (!this.reducedMotion && rand(p.id, 9, p.seq) < 0.3) p.jumpAt = this.t + p.wait * 0.4;
      // The next spot: somewhere within a few steps, kept on the plaza.
      const a = rand(p.id, 8, p.seq) * Math.PI * 2;
      const r = 1.2 + rand(p.id, 10, p.seq) * 3;
      p.tx = clamp(p.x + Math.sin(a) * r, -HALF_W + MARGIN, HALF_W - MARGIN);
      p.tz = clamp(p.z + Math.cos(a) * r, -HALF_D + MARGIN, HALF_D - MARGIN);
      return;
    }
    const s = Math.min(d, speed * dt);
    p.x += (dx / d) * s;
    p.z += (dz / d) * s;
  }
}
