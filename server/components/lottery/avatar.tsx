// One entrant on stage: an original chunky toy character built from primitives (capsule body, big
// round head, stubby limbs, an optional hat), coloured and shaped from their member id. It bobs at
// rest, hops while the wheel spins (smaller and quicker as it slows), and reacts to the result.
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { characterGeometries, starGeometry } from "./shapes";
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

export function Avatar({ name, postCount, look, position, scale, labelLift, crowded, isWinner, show, labelLayer }: AvatarProps) {
  const g = characterGeometries();
  const s = sharedMaterials();
  const [hovered, setHovered] = useState(false);

  const mats = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({ color: look.body, roughness: 0.42, emissive: look.body, emissiveIntensity: 0 }),
      head: new THREE.MeshStandardMaterial({ color: look.head, roughness: 0.5, emissive: "#ffd166", emissiveIntensity: 0 }),
      accent: new THREE.MeshStandardMaterial({ color: look.accent, roughness: 0.45 }),
    }),
    [look],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const mover = useRef<THREE.Group>(null);
  const head = useRef<THREE.Group>(null);
  const armL = useRef<THREE.Group>(null);
  const armR = useRef<THREE.Group>(null);
  const smile = useRef<THREE.Mesh>(null);
  const frown = useRef<THREE.Mesh>(null);
  const crown = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Group>(null);
  const pose = useRef({ yaw: 0, pitch: 0, armUp: 0.25, armFwd: 0, slump: 1, lift: 0, stretch: 1 });

  const h = look.height;
  const bodyCenter = 0.1 + 0.46 * h;
  const neck = 0.1 + 0.92 * h - 0.06;
  const hs = look.headSize;
  const headTop = neck + 0.66 * hs;
  const hatHeight = look.hat === "party" ? 0.38 : look.hat === "antenna" || look.hat === "sprout" ? 0.3 : look.hat === "none" ? 0 : 0.14;

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
    if (mover.current) {
      mover.current.position.y = lift;
      const wide = 1 / Math.sqrt(stretch);
      mover.current.scale.set(wide, stretch, wide);
      mover.current.rotation.set(0, P.yaw + twirl, sway);
    }
    if (head.current) head.current.rotation.set(P.pitch, 0, wave * 0.3);
    const clapSwing = clap ? 0.25 + 0.22 * Math.sin(t * 16 + ph) : 0;
    if (armL.current) armL.current.rotation.set(P.armFwd, 0, P.armUp + wave - clapSwing);
    if (armR.current) armR.current.rotation.set(P.armFwd, 0, -P.armUp + wave + clapSwing);
    if (smile.current) smile.current.visible = !sad;
    if (frown.current) frown.current.visible = sad;

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

  const eyeX = 0.12 + 0.025 * look.eyeSpread;
  const label = (
    <div
      className={`lottery-tag${crowded ? " crowded" : ""}${isWinner ? " winner" : ""}${hovered ? " hovered" : ""}`}
      title={name}
    >
      {isWinner && <span className="lottery-tag-star" aria-hidden="true">★ </span>}
      <span className="lottery-tag-name">{name}</span>
      {isWinner && <span className="lottery-tag-count"> · {postCount === 1 ? "1 post" : `${postCount} posts`}</span>}
    </div>
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
        <group ref={mover}>
          {/* Feet */}
          {[-1, 1].map((side) => (
            <mesh key={side} geometry={g.foot} material={mats.accent} position={[side * 0.15, 0.07, 0.06]} scale={[1, 0.65, 1.3]} castShadow />
          ))}
          <group>
            <mesh geometry={g.body} material={mats.body} position={[0, bodyCenter, 0]} scale={[look.girth, h, look.girth]} castShadow />
            {/* Belly patch */}
            <mesh geometry={g.head} material={s.white} position={[0, bodyCenter - 0.05, 0.2 * look.girth]} scale={[0.42 * look.girth, 0.5 * h, 0.25]} />
            {/* Arms hang from shoulder pivots */}
            <group ref={armL} position={[0.29 * look.girth, neck - 0.14, 0]}>
              <mesh geometry={g.limb} material={mats.body} position={[0, -0.17, 0]} castShadow />
              <mesh geometry={g.ball} material={mats.head} position={[0, -0.32, 0]} scale={1.05} />
            </group>
            <group ref={armR} position={[-0.29 * look.girth, neck - 0.14, 0]}>
              <mesh geometry={g.limb} material={mats.body} position={[0, -0.17, 0]} castShadow />
              <mesh geometry={g.ball} material={mats.head} position={[0, -0.32, 0]} scale={1.05} />
            </group>
          </group>
          <group ref={head} position={[0, neck, 0]}>
            <group position={[0, 0.3 * hs, 0]} scale={hs}>
              <mesh geometry={g.head} material={mats.head} castShadow />
              {[-1, 1].map((side) => (
                <group key={side}>
                  <mesh geometry={g.eye} material={s.ink} position={[side * eyeX, 0.05, 0.315]} scale={[1, 1.25, 0.6]} />
                  <mesh geometry={g.eye} material={s.white} position={[side * eyeX + 0.018, 0.075, 0.345]} scale={0.32} />
                  <mesh geometry={g.eye} material={s.cheek} position={[side * 0.21, -0.06, 0.27]} scale={[1, 0.6, 0.4]} />
                </group>
              ))}
              <mesh ref={smile} geometry={g.smile} material={s.ink} position={[0, -0.05, 0.33]} rotation={[0, 0, Math.PI]} />
              <mesh ref={frown} geometry={g.frown} material={s.ink} position={[0, -0.12, 0.32]} visible={false} />
              {look.ears === "round" &&
                [-1, 1].map((side) => (
                  <mesh key={side} geometry={g.ear} material={mats.body} position={[side * 0.3, 0.24, 0]} scale={[1, 1, 0.6]} />
                ))}
              {look.ears === "pointy" &&
                [-1, 1].map((side) => (
                  <mesh key={side} geometry={g.pointyEar} material={mats.body} position={[side * 0.24, 0.36, 0]} rotation={[0, 0, -side * 0.45]} />
                ))}
              <HatFor look={look} accent={mats.accent} body={mats.body} />
            </group>
          </group>
          {/* Winner's crown, popped on with a spin */}
          <group ref={crown} position={[0, headTop + hatHeight * 0.4 + 0.05, 0]} visible={false} scale={0}>
            <mesh geometry={g.crownBand} material={s.gold} position={[0, 0.08, 0]} />
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const a = (i / 6) * Math.PI * 2;
              return <mesh key={i} geometry={g.ball} material={s.gold} position={[Math.sin(a) * 0.25, 0.2, Math.cos(a) * 0.25]} scale={0.8} />;
            })}
          </group>
        </group>
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
      <Html
        position={[0, headTop + hatHeight + 0.32 + labelLift, 0]}
        center
        zIndexRange={isWinner ? WINNER_Z : hovered ? HOVER_Z : TAG_Z}
        pointerEvents="none"
        // drei only re-sorts a tag's z-index when it moves; the class pins winner and hover on top.
        wrapperClass={isWinner ? "lottery-tag-wrap top" : hovered ? "lottery-tag-wrap raised" : "lottery-tag-wrap"}
        portal={labelLayer as RefObject<HTMLElement>}
      >
        {label}
      </Html>
    </group>
  );
}

function HatFor({ look, accent, body }: { look: Look; accent: THREE.Material; body: THREE.Material }) {
  const g = characterGeometries();
  const s = sharedMaterials();
  switch (look.hat) {
    case "party":
      return (
        <group position={[0, 0.5, 0]} rotation={[0, 0, 0.12]}>
          <mesh geometry={g.cone} material={accent} />
          <mesh geometry={g.ball} material={s.white} position={[0, 0.23, 0]} />
        </group>
      );
    case "beanie":
      return (
        <group position={[0, 0.06, 0]}>
          <mesh geometry={g.dome} material={accent} />
          <mesh geometry={g.ball} material={s.white} position={[0, 0.39, 0]} scale={1.2} />
        </group>
      );
    case "cap":
      return (
        <group position={[0, 0.08, 0]}>
          <mesh geometry={g.dome} material={accent} />
          <mesh geometry={g.brim} material={accent} position={[0, 0.0, 0.2]} scale={[0.75, 1, 0.75]} />
        </group>
      );
    case "antenna":
      return (
        <group position={[0, 0.36, 0]}>
          <mesh geometry={g.stalk} material={s.ink} position={[0, 0.12, 0]} />
          <mesh geometry={g.ball} material={accent} position={[0, 0.28, 0]} scale={1.3} />
        </group>
      );
    case "sprout":
      return (
        <group position={[0, 0.36, 0]}>
          <mesh geometry={g.stalk} material={body} position={[0, 0.1, 0]} />
          <mesh geometry={g.ear} material={accent} position={[0.08, 0.24, 0]} rotation={[0, 0, -0.8]} scale={[1.1, 0.5, 0.6]} />
          <mesh geometry={g.ear} material={accent} position={[-0.08, 0.22, 0]} rotation={[0, 0, 0.8]} scale={[1.1, 0.5, 0.6]} />
        </group>
      );
    case "bow":
      return (
        <group position={[0.16, 0.3, 0.1]} rotation={[0, 0, -0.4]}>
          <mesh geometry={g.cone} material={accent} position={[0.09, 0, 0]} rotation={[0, 0, Math.PI / 2]} scale={0.45} />
          <mesh geometry={g.cone} material={accent} position={[-0.09, 0, 0]} rotation={[0, 0, -Math.PI / 2]} scale={0.45} />
          <mesh geometry={g.ball} material={accent} />
        </group>
      );
    default:
      return null;
  }
}
