// One entrant on stage: an original chunky toy character built from primitives (capsule body, big
// round head, stubby limbs, a face, optional hair and hat), drawn from their Look (their saved
// avatar, or the one generated from their member id). It bobs at rest, hops while the wheel spins
// (smaller and quicker as it slows), and reacts to the result.
//
// `Character` is the figure alone (no name tag, no show state), posed through refs by whoever
// animates it: `Avatar` below on stage, the avatar editor's preview (avatar-preview.tsx) at home.
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { characterGeometries, facialHairGeometry, HAIR_LIFT, hairGeometry, HAIR_TOP, starGeometry } from "./shapes";
import type { Look } from "./look";
import type { Show } from "./types";

let shared: { ink: THREE.Material; cheek: THREE.Material; gold: THREE.MeshStandardMaterial; white: THREE.Material } | null = null;
function sharedMaterials() {
  shared ??= {
    ink: new THREE.MeshStandardMaterial({ color: "#2b1d3a", roughness: 0.3 }),
    cheek: new THREE.MeshStandardMaterial({ color: "#ff8fab", roughness: 0.6 }),
    gold: new THREE.MeshStandardMaterial({ color: "#ffc93c", roughness: 0.25, metalness: 0.35, emissive: "#ff9f1c", emissiveIntensity: 0.35 }),
    white: new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.4 }),
  };
  return shared;
}

/**
 * A hop with squash and stretch. `p` runs 0..1 over one hop: a quick crouch, then the jump.
 * Returns the lift (0..1 of the hop height) and the vertical scale (horizontal is its inverse root).
 */
export function hop(p: number): { lift: number; stretch: number } {
  if (p < 0.18) {
    const k = Math.sin((p / 0.18) * Math.PI);
    return { lift: 0, stretch: 1 - 0.22 * k }; // crouch
  }
  const a = (p - 0.18) / 0.82;
  const lift = 4 * a * (1 - a);
  const speed = Math.abs(1 - 2 * a); // fastest at take-off and landing
  return { lift, stretch: 1 + 0.16 * speed };
}

const TAG_Z = [30, 0];
const HOVER_Z = [49, 40];
const WINNER_Z = [60, 50];

const damp = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));


/** A darker take on a colour (a nose against the face it sits on). */
function shade(hex: string, amount: number): string {
  return `#${new THREE.Color(hex).multiplyScalar(1 - amount).getHexString()}`;
}

export interface CharacterMaterials {
  body: THREE.MeshStandardMaterial;
  head: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  /** Stubble: the hair colour, see-through, a shadow rather than a beard. */
  stubble: THREE.MeshStandardMaterial;
  nose: THREE.MeshStandardMaterial;
}

/** One character's own materials (the stage animates `body` and `head`'s glow). */
export function useCharacterMaterials(look: Look): CharacterMaterials {
  const mats = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({ color: look.body, roughness: 0.42, emissive: look.body, emissiveIntensity: 0 }),
      head: new THREE.MeshStandardMaterial({ color: look.head, roughness: 0.5, emissive: "#ffd166", emissiveIntensity: 0 }),
      accent: new THREE.MeshStandardMaterial({ color: look.accent, roughness: 0.45 }),
      // Open shells (a bob, long hair) show their inside past the face.
      hair: new THREE.MeshStandardMaterial({ color: look.hairColor, roughness: 0.62, side: THREE.DoubleSide }),
      stubble: new THREE.MeshStandardMaterial({ color: look.hairColor, roughness: 0.9, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide }),
      nose: new THREE.MeshStandardMaterial({ color: shade(look.head, 0.16), roughness: 0.5 }),
    }),
    [look],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);
  return mats;
}

/** The parts a character's animator moves. */
export interface CharacterRig {
  mover: RefObject<THREE.Group | null>;
  head: RefObject<THREE.Group | null>;
  armL: RefObject<THREE.Group | null>;
  armR: RefObject<THREE.Group | null>;
  /** The chosen mouth; hidden (and `frown` shown) when the character is sad. */
  mouth: RefObject<THREE.Group | null>;
  frown: RefObject<THREE.Mesh | null>;
}

export function useCharacterRig(): CharacterRig {
  return {
    mover: useRef<THREE.Group>(null),
    head: useRef<THREE.Group>(null),
    armL: useRef<THREE.Group>(null),
    armR: useRef<THREE.Group>(null),
    mouth: useRef<THREE.Group>(null),
    frown: useRef<THREE.Mesh>(null),
  };
}

const DOME_HATS = new Set(["beanie", "cap"]);
/** Styles with volume round the sides, which a dome hat has to grow a little more to cover. */
const BULKY_HAIR = new Set(["bob", "long", "curly", "classicbob", "shoulder", "longdown"]);
const TOPPER_HATS = new Set(["party", "antenna", "sprout"]);

/** Where things are on a character (at scale 1, feet at 0). */
export function figureMetrics(look: Look) {
  const h = look.height;
  const hs = look.headSize;
  const bodyCenter = 0.1 + 0.46 * h;
  const neck = 0.1 + 0.92 * h - 0.06;
  const headTop = neck + 0.66 * hs;
  const hatHeight = look.hat === "party" ? 0.38 : look.hat === "antenna" || look.hat === "sprout" ? 0.3 : look.hat === "none" ? 0 : 0.14;
  const hairTop = (HAIR_TOP[look.hair] ?? 0) * hs;
  // Dome hats cover the hair (its tall parts are trimmed); hats on a stalk ride on top of it.
  const hatLift = TOPPER_HATS.has(look.hat) ? (HAIR_LIFT[look.hair] ?? 0) * hs : 0;
  const above =
    look.hat === "none" ? hairTop : DOME_HATS.has(look.hat) ? hatHeight : look.hat === "bow" ? Math.max(hatHeight, hairTop) : hatLift + hatHeight;
  // The winner's crown sits on the hat, or down over the hair.
  const crownY = headTop + (look.hat === "none" ? hairTop * 0.75 : hatLift + hatHeight * 0.4) + 0.05;
  // The top of the winner's crown (its band and balls stand about 0.3 tall).
  const crownTop = crownY + 0.3;
  return { bodyCenter, neck, headTop, hatHeight, hairTop, hatLift, above, crownY, crownTop };
}

/**
 * The figure itself, posed by its animator through `rig`. `children` go in the moving group (the
 * stage's winner crown). With the generated defaults (dot eyes, smile, no brows, nose or hair)
 * this draws exactly the character the stage always drew.
 */
export function Character({ look, rig, mats, children }: { look: Look; rig: CharacterRig; mats: CharacterMaterials; children?: ReactNode }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  const h = look.height;
  const hs = look.headSize;
  const { bodyCenter, neck } = figureMetrics(look);
  const hasHair = look.hair !== "none";
  const domeHat = DOME_HATS.has(look.hat);
  const hair = hairGeometry(look.hair, domeHat ? "dome" : TOPPER_HATS.has(look.hat) ? "topper" : "full");
  const facial = facialHairGeometry(look.facialHair, look.nose === "snout");
  const earPush = hasHair ? 1.07 : 1;
  // The generated girths (0.9 and up) keep the belly patch just inside the body; a lankier build
  // would let it poke through, so it thins with the body there.
  const belly = Math.min(1, (look.girth / 0.9) ** 2);
  return (
    <group ref={rig.mover}>
      {/* Feet */}
      {[-1, 1].map((side) => (
        <mesh key={side} geometry={g.foot} material={mats.accent} position={[side * 0.15, 0.07, 0.06]} scale={[1, 0.65, 1.3]} castShadow />
      ))}
      <group>
        <mesh geometry={g.body} material={mats.body} position={[0, bodyCenter, 0]} scale={[look.girth, h, look.girth]} castShadow />
        {/* Belly patch (kept inside a thinner-than-generated body: see `belly`) */}
        <mesh geometry={g.head} material={s.white} position={[0, bodyCenter - 0.05, 0.2 * look.girth]} scale={[0.42 * look.girth, 0.5 * h, 0.25 * belly]} />
        {/* Arms hang from shoulder pivots */}
        <group ref={rig.armL} position={[0.29 * look.girth, neck - 0.14, 0]}>
          <mesh geometry={g.limb} material={mats.body} position={[0, -0.17, 0]} castShadow />
          <mesh geometry={g.ball} material={mats.head} position={[0, -0.32, 0]} scale={1.05} />
        </group>
        <group ref={rig.armR} position={[-0.29 * look.girth, neck - 0.14, 0]}>
          <mesh geometry={g.limb} material={mats.body} position={[0, -0.17, 0]} castShadow />
          <mesh geometry={g.ball} material={mats.head} position={[0, -0.32, 0]} scale={1.05} />
        </group>
      </group>
      <group ref={rig.head} position={[0, neck, 0]}>
        <group position={[0, 0.3 * hs, 0]} scale={hs}>
          <mesh geometry={g.head} material={mats.head} castShadow />
          <Eyes look={look} />
          {[-1, 1].map((side) => (
            <mesh key={side} geometry={g.eye} material={s.cheek} position={[side * 0.21, -0.06, 0.27]} scale={[1, 0.6, 0.4]} />
          ))}
          <Brows look={look} hair={mats.hair} />
          <NoseFor look={look} nose={mats.nose} />
          <group ref={rig.mouth}>
            <MouthFor look={look} />
          </group>
          {/* Tipped forward to follow the face: upright at z 0.32 it sat almost inside the head and
              showed as two dots. */}
          <mesh ref={rig.frown} geometry={g.frown} material={s.ink} position={[0, -0.125, 0.345]} rotation={[0.35, 0, 0]} visible={false} />
          {look.ears === "round" &&
            [-1, 1].map((side) => (
              <mesh key={side} geometry={g.ear} material={mats.body} position={[side * 0.3 * earPush, 0.24, 0]} scale={[1, 1, 0.6]} />
            ))}
          {look.ears === "pointy" &&
            [-1, 1].map((side) => (
              <mesh key={side} geometry={g.pointyEar} material={mats.body} position={[side * 0.24 * earPush, 0.36 * earPush, 0]} rotation={[0, 0, -side * 0.45]} />
            ))}
          {hair && <mesh geometry={hair} material={mats.hair} castShadow />}
          {facial && <mesh geometry={facial} material={look.facialHair === "stubble" ? mats.stubble : mats.hair} />}
          <HatFor look={look} accent={mats.accent} body={mats.body} />
        </group>
      </group>
      {children}
    </group>
  );
}

function eyeOffset(look: Look) {
  return 0.12 + 0.025 * look.eyeSpread;
}

function Eyes({ look }: { look: Look }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  const eyeX = eyeOffset(look);
  const dot = (side: number) => (
    <group key={side}>
      <mesh geometry={g.eye} material={s.ink} position={[side * eyeX, 0.05, 0.315]} scale={[1, 1.25, 0.6]} />
      <mesh geometry={g.eye} material={s.white} position={[side * eyeX + 0.018, 0.075, 0.345]} scale={0.32} />
    </group>
  );
  // A closed, happy eye: an upside-down U.
  const arc = (side: number) => (
    <mesh key={side} geometry={g.smile} material={s.ink} position={[side * eyeX, 0.03, 0.33]} scale={[0.55, 0.6, 0.8]} />
  );
  switch (look.eyes) {
    case "big":
      return (
        <>
          {[-1, 1].map((side) => {
            const x = side * (eyeX + 0.012);
            return (
              <group key={side}>
                <mesh geometry={g.eye} material={s.ink} position={[x, 0.045, 0.31]} scale={[1.45, 1.8, 0.62]} />
                <mesh geometry={g.eye} material={s.white} position={[x + 0.026, 0.085, 0.35]} scale={0.5} />
                <mesh geometry={g.eye} material={s.white} position={[x - 0.022, 0.012, 0.352]} scale={0.22} />
              </group>
            );
          })}
        </>
      );
    case "sleepy":
      // Heavy lids over the top half, a lash line under them.
      return (
        <>
          {[-1, 1].map((side) => (
            <group key={side} position={[side * eyeX, 0.045, 0.315]} rotation={[0, 0, side * -0.12]}>
              <mesh geometry={g.eye} material={s.ink} scale={[1.1, 0.75, 0.6]} />
              <mesh geometry={g.bar} material={s.ink} position={[0, 0.006, 0.02]} scale={[0.85, 0.9, 1]} />
              <mesh geometry={g.dome} material={sharedLid(look.head)} position={[0, 0.004, 0.0]} scale={[0.19, 0.17, 0.12]} />
            </group>
          ))}
        </>
      );
    case "happy":
      return <>{[-1, 1].map(arc)}</>;
    case "wink": {
      // One open eye; the other squeezed shut, a ">" (or "<").
      return (
        <>
          {dot(-1)}
          <group position={[eyeX, 0.05, 0.325]}>
            <mesh geometry={g.bar} material={s.ink} position={[0, 0.017, 0]} rotation={[0, 0, -0.5]} scale={[0.75, 1, 1]} />
            <mesh geometry={g.bar} material={s.ink} position={[0, -0.017, 0]} rotation={[0, 0, 0.5]} scale={[0.75, 1, 1]} />
          </group>
        </>
      );
    }
    case "starry":
      return (
        <>
          {[-1, 1].map((side) => (
            <mesh
              key={side}
              geometry={starGeometry()}
              material={s.gold}
              position={[side * (eyeX + 0.005), 0.05, 0.325]}
              rotation={[0, side * 0.3, 0]}
              scale={[0.17, 0.17, 0.3]}
            />
          ))}
        </>
      );
    default:
      return <>{[-1, 1].map(dot)}</>;
  }
}

// Sleepy lids are the face's own colour; a handful of skins, so share them per colour.
const lids = new Map<string, THREE.MeshStandardMaterial>();
function sharedLid(color: string) {
  let m = lids.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    lids.set(color, m);
  }
  return m;
}

function Brows({ look, hair }: { look: Look; hair: THREE.Material }) {
  const g = characterGeometries();
  if (look.brows === "none") return null;
  const big = look.eyes === "big";
  const x = eyeOffset(look) + (big ? 0.012 : 0);
  const y = big ? 0.19 : 0.16;
  return (
    <>
      {[-1, 1].map((side) => {
        // Turned to follow the curve of the head.
        const common = { material: hair, rotation: [-0.35, side * 0.38, 0] as [number, number, number] };
        switch (look.brows) {
          case "soft":
            return (
              <group key={side} position={[side * x, y, 0.29]} {...common}>
                <mesh geometry={g.browArc} material={hair} scale={[0.95, 0.45, 1]} />
              </group>
            );
          case "arched":
            return (
              <group key={side} position={[side * x, y + 0.01, 0.288]} {...common}>
                <mesh geometry={g.browArc} material={hair} scale={[0.95, 1.05, 1.1]} rotation={[0, 0, side * -0.18]} />
              </group>
            );
          case "angry":
            return (
              <group key={side} position={[side * x, y - 0.012, 0.3]} {...common}>
                <mesh geometry={g.bar} material={hair} rotation={[0, 0, side * 0.45]} scale={[1, 1.15, 1]} />
              </group>
            );
          case "worried":
            return (
              <group key={side} position={[side * x, y + 0.015, 0.292]} {...common}>
                <mesh geometry={g.bar} material={hair} rotation={[0, 0, side * -0.4]} />
              </group>
            );
          case "thick":
            return (
              <group key={side} position={[side * x, y + 0.005, 0.296]} {...common}>
                <mesh geometry={g.bar} material={hair} rotation={[0, 0, side * -0.08]} scale={[1.3, 2.1, 1.3]} />
              </group>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function NoseFor({ look, nose }: { look: Look; nose: THREE.Material }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  switch (look.nose) {
    case "button":
      return <mesh geometry={g.ball} material={s.cheek} position={[0, -0.005, 0.356]} scale={0.48} />;
    case "pointy":
      return <mesh geometry={g.cone} material={nose} position={[0, 0.0, 0.39]} rotation={[Math.PI / 2 - 0.25, 0, 0]} scale={[0.24, 0.3, 0.24]} />;
    case "round":
      return <mesh geometry={g.ball} material={nose} position={[0, -0.01, 0.348]} scale={[0.8, 0.72, 0.75]} />;
    case "snout":
      return (
        <group position={[0, -0.018, 0.35]}>
          <mesh geometry={g.snout} material={nose} scale={[1, 0.78, 1]} />
          {[-1, 1].map((side) => (
            <mesh key={side} geometry={g.eye} material={s.ink} position={[side * 0.024, 0, 0.036]} scale={[0.3, 0.42, 0.25]} />
          ))}
        </group>
      );
    default:
      return null;
  }
}

function MouthFor({ look }: { look: Look }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  const smile = <mesh geometry={g.smile} material={s.ink} position={[0, -0.05, 0.33]} rotation={[0, 0, Math.PI]} />;
  switch (look.mouth) {
    case "grin":
      // Wide open: a D of ink, a row of teeth along the top, a tongue.
      return (
        <group position={[0, -0.06, 0.325]}>
          <mesh geometry={g.grin} material={s.ink} scale={[1.05, 0.95, 0.38]} />
          <mesh geometry={g.bar} material={s.white} position={[0, -0.012, 0.022]} scale={[1.45, 0.9, 0.6]} />
          <mesh geometry={g.eye} material={s.cheek} position={[0, -0.062, 0.016]} scale={[0.95, 0.42, 0.4]} />
        </group>
      );
    case "smirk":
      return <mesh geometry={g.smile} material={s.ink} position={[0.035, -0.06, 0.332]} rotation={[0, 0.1, Math.PI - 0.38]} scale={[0.72, 0.62, 1]} />;
    case "o":
      return <mesh geometry={g.eye} material={s.ink} position={[0, -0.095, 0.33]} scale={[0.85, 1.05, 0.5]} />;
    case "flat":
      return <mesh geometry={g.bar} material={s.ink} position={[0, -0.085, 0.335]} scale={[1.05, 1, 1]} />;
    case "tooth":
      // The smile, and one goofy front tooth.
      return (
        <>
          {smile}
          <mesh geometry={g.eye} material={s.white} position={[0.02, -0.132, 0.334]} scale={[0.7, 0.85, 0.4]} />
        </>
      );
    default:
      return smile;
  }
}

export interface AvatarProps {
  name: string;
  postCount: number;
  look: Look;
  position: [number, number, number];
  scale: number;
  labelLift: number;
  crowded: boolean;
  isWinner: boolean;
  show: RefObject<Show>;
  /** A fixed DOM layer over the canvas for the name tags (a stable target: see stage.tsx). */
  labelLayer: RefObject<HTMLDivElement | null>;
}

/** What the name tag carries for tests and debugging: the look this character was drawn from. */
function lookSummary(look: Look): string {
  const { body, head, accent, hat, ears, hair, facialHair, hairColor, eyes, brows, nose, mouth, height, girth, headSize } = look;
  return JSON.stringify({ skin: head, outfit: body, accent, hat, ears, hair, facialHair, hairColor, eyes, brows, nose, mouth, height, girth, headSize });
}

export function Avatar({ name, postCount, look, position, scale, labelLift, crowded, isWinner, show, labelLayer }: AvatarProps) {
  const g = characterGeometries();
  const s = sharedMaterials();
  const [hovered, setHovered] = useState(false);
  const mats = useCharacterMaterials(look);
  const rig = useCharacterRig();
  const crown = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Group>(null);
  const pose = useRef({ yaw: 0, pitch: 0, armUp: 0.25, armFwd: 0, slump: 1, lift: 0, stretch: 1 });
  const { headTop, above, crownY, crownTop } = figureMetrics(look);

  useFrame((state, dt) => {
    const sh = show.current;
    const t = state.clock.elapsedTime;
    const ph = look.phase;
    const [x, , z] = position;
    const P = pose.current;
    let lift = 0;
    let stretch = 1;
    let yaw = 0;
    let pitch = 0;
    let armUp = 0.25;
    let armFwd = 0;
    let wave = 0;
    let clap = false;
    let sad = false;
    let twirl = 0;
    let sway = 0;

    if (sh.reducedMotion) {
      // Still poses only: the winner holds their arms up; nobody moves.
      if (sh.phase === "won" && isWinner) armUp = 2.5;
      if (sh.phase === "won" && !isWinner && look.reaction === "bummed") sad = true;
    } else if (sh.phase === "ready") {
      stretch = 1 + 0.035 * Math.sin(t * 2.2 + ph);
      sway = 0.05 * Math.sin(t * 1.3 + ph);
      armUp = 0.3 + 0.1 * Math.sin(t * 2.2 + ph);
      // Now and then, a happy little hop.
      const cycle = 7 + (ph % 3);
      const local = (t + ph * 3) % cycle;
      if (local < 0.6) {
        const k = hop(local / 0.6);
        lift = k.lift * 0.22;
        stretch = k.stretch;
      }
    } else if (sh.phase === "spinning") {
      const p = sh.progress;
      // The hop phase comes from the stage's integrated beat (see Show.hopBeat), never t % period.
      const beat = (((sh.hopBeat + ph / (Math.PI * 2)) % 1) + 1) % 1;
      // Watch the wheel: turn toward the middle and look up.
      yaw = Math.max(-0.7, Math.min(0.7, -x * 0.12));
      pitch = -0.32;
      if (p < 0.7) {
        const k = hop(beat);
        lift = k.lift * 0.18;
        stretch = k.stretch;
        armUp = 1.6 + 0.6 * Math.sin(t * 10 + ph);
      } else {
        // Anticipation: hands together, smaller and quicker hops as the wheel creeps to a stop.
        const tension = (p - 0.7) / 0.3;
        const k = hop(beat);
        lift = k.lift * (0.12 - 0.07 * tension);
        stretch = k.stretch;
        armUp = 0.5;
        armFwd = -1.25;
      }
    } else {
      const e = t - sh.since;
      if (isWinner) {
        const k = hop(((e + 0.18 * 0.8) % 0.78) / 0.78);
        lift = k.lift * 0.6;
        stretch = k.stretch;
        armUp = 2.5 + 0.25 * Math.sin(t * 12);
        wave = 0.3 * Math.sin(t * 9);
        twirl = e < 0.9 ? (e / 0.9) * Math.PI * 2 : 0;
      } else {
        // Face the winner, then react in character.
        yaw = Math.max(-0.9, Math.min(0.9, Math.atan2(sh.winnerX - x, sh.winnerZ - z + 3)));
        const reaction = look.reaction === "bummed" && e > 4 ? "clap" : look.reaction;
        if (reaction === "cheer") {
          const k = hop(((t + ph) % 0.62) / 0.62);
          lift = k.lift * 0.25;
          stretch = k.stretch;
          armUp = 2.2 + 0.4 * Math.sin(t * 11 + ph);
        } else if (reaction === "clap") {
          stretch = 1 + 0.03 * Math.sin(t * 6 + ph);
          armUp = 0.6;
          armFwd = -1.35;
          clap = true;
        } else {
          sad = true;
          stretch = 0.9;
          pitch = 0.4;
          armUp = 0.08;
          sway = 0.04 * Math.sin(t * 1.1 + ph);
        }
      }
    }

    P.yaw = damp(P.yaw, yaw, 6, dt);
    P.pitch = damp(P.pitch, pitch, 6, dt);
    P.armUp = damp(P.armUp, armUp, 10, dt);
    P.armFwd = damp(P.armFwd, armFwd, 10, dt);
    // Lightly smoothed so a change of phase (the wheel stopping) blends instead of snapping.
    P.lift = sh.reducedMotion ? lift : damp(P.lift, lift, 22, dt);
    P.stretch = sh.reducedMotion ? stretch : damp(P.stretch, stretch, 22, dt);
    lift = P.lift;
    stretch = P.stretch;
    if (rig.mover.current) {
      rig.mover.current.position.y = lift;
      const wide = 1 / Math.sqrt(stretch);
      rig.mover.current.scale.set(wide, stretch, wide);
      rig.mover.current.rotation.set(0, P.yaw + twirl, sway);
    }
    if (rig.head.current) rig.head.current.rotation.set(P.pitch, 0, wave * 0.3);
    const clapSwing = clap ? 0.25 + 0.22 * Math.sin(t * 16 + ph) : 0;
    if (rig.armL.current) rig.armL.current.rotation.set(P.armFwd, 0, P.armUp + wave - clapSwing);
    if (rig.armR.current) rig.armR.current.rotation.set(P.armFwd, 0, -P.armUp + wave + clapSwing);
    if (rig.mouth.current) rig.mouth.current.visible = !sad;
    if (rig.frown.current) rig.frown.current.visible = sad;

    // Winner glow, crown and halo.
    const glow = isWinner && sh.phase === "won" ? (sh.reducedMotion ? 0.35 : 0.3 + 0.2 * Math.sin(t * 5)) : 0;
    mats.body.emissiveIntensity = damp(mats.body.emissiveIntensity, glow, 8, dt);
    mats.head.emissiveIntensity = damp(mats.head.emissiveIntensity, glow * 0.6, 8, dt);
    if (crown.current) {
      const target = isWinner && sh.phase === "won" ? 1 : 0;
      const cur = crown.current.scale.x;
      const next = sh.reducedMotion ? target : damp(cur, target, 9, dt);
      crown.current.scale.setScalar(next);
      crown.current.visible = next > 0.01;
      if (!sh.reducedMotion) crown.current.rotation.y = t * 0.8;
    }
    if (halo.current) {
      halo.current.visible = isWinner && sh.phase === "won";
      if (!sh.reducedMotion) halo.current.rotation.y = t * 1.6;
    }
  });

  const label = (
    <div
      className={`lottery-tag${crowded ? " crowded" : ""}${isWinner ? " winner" : ""}${hovered ? " hovered" : ""}`}
      title={name}
      data-look={lookSummary(look)}
    >
      {isWinner && <span className="lottery-tag-star" aria-hidden="true">★ </span>}
      <span className="lottery-tag-name">{name}</span>
      {isWinner && <span className="lottery-tag-count"> · {postCount === 1 ? "1 post" : `${postCount} posts`}</span>}
    </div>
  );

  // The winner's tag rides with them, just over the crown, so their hops never pass behind it
  // (their hair and crown stay in view in the close-up); everyone else's stays over their space.
  const tag = (
    <Html
      position={[0, isWinner ? crownTop + 0.14 : headTop + above + 0.32 + labelLift, 0]}
      center
      zIndexRange={isWinner ? WINNER_Z : hovered ? HOVER_Z : TAG_Z}
      pointerEvents="none"
      // drei only re-sorts a tag's z-index when it moves; the class pins winner and hover on top.
      wrapperClass={isWinner ? "lottery-tag-wrap top" : hovered ? "lottery-tag-wrap raised" : "lottery-tag-wrap"}
      portal={labelLayer as RefObject<HTMLElement>}
    >
      {label}
    </Html>
  );

  return (
    <group position={position} scale={scale}>
      <group
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
      >
        <Character look={look} rig={rig} mats={mats}>
          {/* Winner's crown, popped on with a spin */}
          <group ref={crown} position={[0, crownY, 0]} visible={false} scale={0}>
            <mesh geometry={g.crownBand} material={s.gold} position={[0, 0.08, 0]} />
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const a = (i / 6) * Math.PI * 2;
              return <mesh key={i} geometry={g.ball} material={s.gold} position={[Math.sin(a) * 0.25, 0.2, Math.cos(a) * 0.25]} scale={0.8} />;
            })}
          </group>
          {isWinner && tag}
        </Character>
        {/* Golden ring and orbiting stars at the winner's feet */}
        <group ref={halo} visible={false}>
          <mesh geometry={g.ring} material={s.gold} rotation={[Math.PI / 2, 0, 0]} position={[0, 0.04, 0]} />
          {[0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2;
            return (
              <mesh
                key={i}
                geometry={starGeometry()}
                material={s.gold}
                position={[Math.sin(a) * 0.6, 0.35 + (i % 2) * 0.5, Math.cos(a) * 0.6]}
                scale={0.26}
              />
            );
          })}
        </group>
      </group>
      {!isWinner && tag}
    </group>
  );
}

function HatFor({ look, accent, body }: { look: Look; accent: THREE.Material; body: THREE.Material }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  // With hair: hats on a stalk ride on top of it, domes grow to cover it, a bow sits out on it.
  const lift = TOPPER_HATS.has(look.hat) ? (HAIR_LIFT[look.hair] ?? 0) : 0;
  const dome = look.hair === "none" ? 1 : BULKY_HAIR.has(look.hair) ? 1.13 : 1.08;
  const out = look.hair === "none" ? 1 : 1.12;
  // A dome over hair rides up with it, so it doesn't come down over the eyes.
  const domeUp = (dome - 1) * 0.6;
  switch (look.hat) {
    case "party":
      return (
        <group position={[0, 0.5 + lift, 0]} rotation={[0, 0, 0.12]}>
          <mesh geometry={g.cone} material={accent} />
          <mesh geometry={g.ball} material={s.white} position={[0, 0.23, 0]} />
        </group>
      );
    case "beanie":
      return (
        <group position={[0, 0.06 + domeUp, 0]} scale={dome}>
          <mesh geometry={g.dome} material={accent} />
          <mesh geometry={g.ball} material={s.white} position={[0, 0.39, 0]} scale={1.2} />
        </group>
      );
    case "cap":
      return (
        <group position={[0, 0.08 + domeUp, 0]} scale={dome}>
          <mesh geometry={g.dome} material={accent} />
          <mesh geometry={g.brim} material={accent} position={[0, 0.0, 0.2]} scale={[0.75, 1, 0.75]} />
        </group>
      );
    case "antenna":
      return (
        <group position={[0, 0.36 + lift, 0]}>
          <mesh geometry={g.stalk} material={s.ink} position={[0, 0.12, 0]} />
          <mesh geometry={g.ball} material={accent} position={[0, 0.28, 0]} scale={1.3} />
        </group>
      );
    case "sprout":
      return (
        <group position={[0, 0.36 + lift, 0]}>
          <mesh geometry={g.stalk} material={body} position={[0, 0.1, 0]} />
          <mesh geometry={g.ear} material={accent} position={[0.08, 0.24, 0]} rotation={[0, 0, -0.8]} scale={[1.1, 0.5, 0.6]} />
          <mesh geometry={g.ear} material={accent} position={[-0.08, 0.22, 0]} rotation={[0, 0, 0.8]} scale={[1.1, 0.5, 0.6]} />
        </group>
      );
    case "bow":
      return (
        <group position={[0.16 * out, 0.3 * out, 0.1 * out]} rotation={[0, 0, -0.4]}>
          <mesh geometry={g.cone} material={accent} position={[0.09, 0, 0]} rotation={[0, 0, Math.PI / 2]} scale={0.45} />
          <mesh geometry={g.cone} material={accent} position={[-0.09, 0, 0]} rotation={[0, 0, -Math.PI / 2]} scale={0.45} />
          <mesh geometry={g.ball} material={accent} />
        </group>
      );
    default:
      return null;
  }
}
