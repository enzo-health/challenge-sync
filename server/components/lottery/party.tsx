// The dance party on the public lottery page (app/lottery): everyone on the lottery's board-game
// stage, dancing to one beat, and now and then two of them popping out of their spaces and back in
// each other's. A gold star spins over everyone in the coming draw. The same characters, set and
// camera as the wheel's stage (avatar.tsx, scenery.tsx, stage.tsx's FitCamera), without the wheel.
// Loaded lazily like stage.tsx.
//
// Each figure is the stage's Character, posed every frame by its own small useFrame; shadows are
// off so the set draws in one pass, which keeps 50+ dancers smooth.
import { type RefObject, useMemo, useRef } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { Character, figureMetrics, hop, useCharacterMaterials, useCharacterRig } from "./avatar";
import { layoutFor, type Layout } from "./layout";
import { type Look, resolveLook } from "./look";
import { Scenery } from "./scenery";
import { starGeometry } from "./shapes";
import { FitCamera, type BasePose } from "./stage";
import type { StagePerson } from "./types";

export interface PartyGuest extends StagePerson {
  /** In the coming draw: a star over their head. */
  starred: boolean;
}

/** Beats per second: 120 bpm. */
const BEAT = 2;
/** Seconds between two dancers trading places, and how long a pop out (and back in) takes. */
const SWAP_EVERY = 1.7;
const POP = 0.28;

/** Who stands where (indices into layout.stage) and who is mid-pop, shared by the dancers. */
interface Floor {
  home: number[];
  /** Scene time a dancer started popping out, or -Infinity. */
  popAt: number[];
  /** The space a popping dancer comes back in at. */
  next: number[];
  lastSwap: number;
}

const gold = new THREE.MeshStandardMaterial({ color: "#ffc93c", roughness: 0.25, metalness: 0.35, emissive: "#ff9f1c", emissiveIntensity: 0.4 });

type Move = "bounce" | "twirl" | "wave" | "shuffle";
const MOVES: Move[] = ["bounce", "twirl", "wave", "shuffle"];

function Dancer({
  guest,
  look,
  index,
  layout,
  floor,
  reducedMotion,
  labelLayer,
}: {
  guest: PartyGuest;
  look: Look;
  index: number;
  layout: Layout;
  floor: RefObject<Floor>;
  reducedMotion: boolean;
  labelLayer: RefObject<HTMLDivElement | null>;
}) {
  const rig = useCharacterRig();
  const mats = useCharacterMaterials(look);
  const place = useRef<THREE.Group>(null);
  const star = useRef<THREE.Mesh>(null);
  const { headTop, above } = figureMetrics(look);
  const move = MOVES[Math.floor((look.phase / (Math.PI * 2)) * MOVES.length) % MOVES.length];

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const f = floor.current;
    const g = place.current;
    if (!g) return;
    // Where they stand, and the pop: shrink away, then spring back up in the new space.
    let pop = 1;
    const since = t - f.popAt[index];
    if (since >= 0 && since < 2 * POP) {
      if (since >= POP && f.next[index] >= 0) {
        f.home[index] = f.next[index];
        f.next[index] = -1;
      }
      pop = since < POP ? 1 - since / POP : Math.min(1.12, ((since - POP) / POP) * 1.12);
    } else if (since >= 2 * POP) {
      const settle = Math.max(0, 1 - (since - 2 * POP) / 0.15);
      pop = 1 + 0.12 * settle;
    }
    const spot = layout.stage[f.home[index]] ?? layout.stage[index];
    g.position.set(spot.x, spot.y, spot.z);
    g.scale.setScalar(layout.stageScale * Math.max(0.001, pop));

    const ph = look.phase;
    let lift = 0;
    let stretch = 1;
    let yaw = 0;
    let armL = 0.3;
    let armR = -0.3;
    let sway = 0;
    if (!reducedMotion) {
      const beat = (t * BEAT + ph / (Math.PI * 2)) % 1;
      const k = hop(beat);
      if (move === "bounce") {
        lift = k.lift * 0.3;
        stretch = k.stretch;
        armL = 2.3 + 0.3 * Math.sin(t * 12 + ph);
        armR = -armL;
      } else if (move === "twirl") {
        // Two hops, then a spin on the spot.
        const bar = (t * BEAT * 0.25 + ph) % 1;
        yaw = bar > 0.5 ? ((bar - 0.5) / 0.5) * Math.PI * 2 : 0;
        lift = k.lift * 0.16;
        stretch = k.stretch;
        armL = 1.2;
        armR = -1.2;
      } else if (move === "wave") {
        // Arms up one side at a time, swaying to the beat.
        const side = Math.sin(t * Math.PI * BEAT * 0.5 + ph);
        armL = 1.4 + 1.1 * side;
        armR = -1.4 + 1.1 * side;
        sway = 0.12 * side;
        stretch = 1 + 0.05 * Math.sin(t * Math.PI * 2 * BEAT + ph);
      } else {
        // Side to side with little steps.
        const step = Math.sin(t * Math.PI * BEAT + ph);
        yaw = 0.45 * step;
        lift = Math.abs(step) * 0.08;
        armL = 0.6 + 0.4 * step;
        armR = -0.6 + 0.4 * step;
        sway = 0.06 * step;
      }
    }
    const m = rig.mover.current;
    if (m) {
      m.position.y = lift;
      const wide = 1 / Math.sqrt(stretch);
      m.scale.set(wide, stretch, wide);
      m.rotation.set(0, yaw, sway);
    }
    rig.armL.current?.rotation.set(0, 0, armL);
    rig.armR.current?.rotation.set(0, 0, armR);
    if (rig.mouth.current) rig.mouth.current.visible = true;
    if (rig.frown.current) rig.frown.current.visible = false;
    const s = star.current;
    if (s) {
      s.position.y = headTop + above + 0.42 + lift + 0.05 * Math.sin(t * 2 + ph);
      s.rotation.set(-0.3, reducedMotion ? 0 : 0.6 * Math.sin(t * 1.8 + ph), 0);
    }
  });

  return (
    <group ref={place}>
      <Character look={look} rig={rig} mats={mats} />
      {guest.starred && <mesh ref={star} geometry={starGeometry()} material={gold} scale={0.42} />}
      <Html
        position={[0, headTop + above + (guest.starred ? 0.95 : 0.36), 0]}
        center
        zIndexRange={[30, 0]}
        pointerEvents="none"
        wrapperClass="lottery-tag-wrap"
        portal={labelLayer as RefObject<HTMLElement>}
      >
        <div className={`lottery-tag party-tag${layout.crowded ? " crowded" : ""}${guest.starred ? " starred" : ""}`} title={guest.displayName}>
          {guest.starred && <span className="lottery-tag-star" aria-hidden="true">★ </span>}
          <span className="lottery-tag-name">{guest.displayName}</span>
        </div>
      </Html>
    </group>
  );
}

/** Every SWAP_EVERY seconds two dancers (not mid-pop) pop out and back in each other's spaces. */
function SwapDirector({ floor, count, reducedMotion }: { floor: RefObject<Floor>; count: number; reducedMotion: boolean }) {
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const f = floor.current;
    if (reducedMotion || count < 2 || t - f.lastSwap < SWAP_EVERY) return;
    f.lastSwap = t;
    const free = f.popAt.map((at, i) => (t - at > 2 * POP + 0.2 ? i : -1)).filter((i) => i >= 0);
    if (free.length < 2) return;
    const a = free[Math.floor(Math.random() * free.length)];
    let b = free[Math.floor(Math.random() * free.length)];
    if (b === a) b = free[(free.indexOf(a) + 1) % free.length];
    f.next[a] = f.home[b];
    f.next[b] = f.home[a];
    f.popAt[a] = t;
    f.popAt[b] = t + 0.12;
  });
  return null;
}

export default function PartyStage({
  guests,
  reducedMotion,
  label,
  topInset = 0,
}: {
  guests: PartyGuest[];
  reducedMotion: boolean;
  label: string;
  /** Pixels at the top the page covers (its info card): the camera frames the floor below them. */
  topInset?: number;
}) {
  const layout = useMemo(() => layoutFor(guests.length, 0, false), [guests.length]);
  const looks = useMemo(() => guests.map((g) => resolveLook(g.memberId, g.avatar)), [guests]);
  const floor = useRef<Floor>({ home: [], popAt: [], next: [], lastSwap: 0 });
  if (floor.current.home.length !== guests.length) {
    floor.current = {
      home: guests.map((_, i) => i),
      popAt: guests.map(() => Number.NEGATIVE_INFINITY),
      next: guests.map(() => -1),
      lastSwap: 0,
    };
  }
  const base = useRef<BasePose>({ ready: false, position: new THREE.Vector3(), aim: new THREE.Vector3() });
  const labelLayer = useRef<HTMLDivElement>(null);
  return (
    <div className="lottery-stage party-stage">
      <div className="lottery-canvas" role="img" aria-label={label}>
        <Canvas flat dpr={[1, 1.5]} camera={{ fov: 34, near: 0.1, far: 300, position: [0, 6, 22] }} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}>
          <FitCamera points={layout.frame} bottomInset={0} topInset={topInset} base={base} />
          <hemisphereLight args={["#dff1ff", "#ffe2c6", 1.4]} />
          <directionalLight position={[6, 14, 9]} intensity={2.1} />
          <Scenery layout={layout} reducedMotion={reducedMotion} />
          <SwapDirector floor={floor} count={guests.length} reducedMotion={reducedMotion} />
          {guests.map((guest, i) => (
            <Dancer
              key={guest.memberId}
              guest={guest}
              look={looks[i]}
              index={i}
              layout={layout}
              floor={floor}
              reducedMotion={reducedMotion}
              labelLayer={labelLayer}
            />
          ))}
        </Canvas>
        <div className="lottery-labels" ref={labelLayer} />
      </div>
    </div>
  );
}
