// The 3D lottery show (loaded lazily by app/admin/lottery/page.tsx, so three.js only downloads
// for this page). Pure props in, `onSpinEnd` out: the page owns the draw; this only performs it.
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Avatar, figureMetrics } from "./avatar";
import { Confetti, type Volley } from "./confetti";
import { Crowd } from "./crowd";
import { easeInOutSine, landingRotation, sliceUnderPointer, spinProgress, spinRotation, type SpinPlan } from "./draw";
import { layoutFor, type Layout, type Spot } from "./layout";
import { resolveLook } from "./look";
import { Scenery, surfaceAt } from "./scenery";
import type { LotteryStageProps, Show, ShowPhase, SpinRequest, StageEntrant, StagePerson } from "./types";
import { Wheel } from "./wheel";

/** The fitted wide shot, which the camera rig starts from and comes back to. */
interface BasePose {
  ready: boolean;
  position: THREE.Vector3;
  aim: THREE.Vector3;
}

/**
 * Computes the wide shot that keeps the whole set in frame at any canvas size (a slightly raised,
 * straight-on view) and places the camera there; `CameraRig` moves it from there on a win.
 */
function FitCamera({ points, bottomInset, base }: { points: Layout["frame"]; bottomInset: number; base: RefObject<BasePose> }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useLayoutEffect(() => {
    if (width === 0 || height === 0 || points.length === 0) return;
    const box = new THREE.Box3().setFromPoints(points.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
    const center = box.getCenter(new THREE.Vector3());
    const elevation = 0.5;
    const dir = new THREE.Vector3(0, Math.sin(elevation), Math.cos(elevation));
    const corners = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    const v = new THREE.Vector3();
    // Aim at the box centre, then nudge the aim so the projected points are centred too.
    const aim = center.clone();
    const place = (dist: number) => {
      camera.position.copy(aim).addScaledVector(dir, dist);
      camera.lookAt(aim);
      camera.updateMatrixWorld();
    };
    const extent = () => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, behind = false;
      for (const c of corners) {
        v.copy(c).project(camera);
        if (v.z >= 1) behind = true;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
      return { minX, maxX, minY, maxY, behind };
    };
    // Keep everything above the control bar: NDC y runs -1 (bottom) .. 1 (top).
    const floor = -0.97 + (2 * Math.min(bottomInset, height * 0.4)) / height;
    const fit = () => {
      let lo = 1;
      let hi = 400;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        place(mid);
        const e = extent();
        if (!e.behind && e.minX >= -0.97 && e.maxX <= 0.97 && e.minY >= floor && e.maxY <= 0.95) hi = mid;
        else lo = mid;
      }
      place(hi);
      return hi;
    };
    for (let pass = 0; pass < 3; pass++) {
      const dist = fit();
      const e = extent();
      // Shift the aim by the off-centre amount (in world units at the aim's distance).
      const halfH = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * dist;
      const up = new THREE.Vector3(0, Math.cos(elevation), -Math.sin(elevation));
      aim.addScaledVector(up, ((e.maxY + e.minY) / 2 - (floor + 0.95) / 2) * halfH);
    }
    fit();
    base.current.position.copy(camera.position);
    base.current.aim.copy(aim);
    base.current.ready = true;
  }, [camera, width, height, points, bottomInset, base]);
  return null;
}

/** Hops per second for the stage avatars while the wheel spins: brisk, then quicker as it slows. */
function stageHopRate(progress: number): number {
  if (progress < 0.7) return 2;
  return 1 / (0.42 - 0.18 * ((progress - 0.7) / 0.3));
}

/** Hops per second for the crowd's anticipation bobs, quickening through the spin. */
function crowdHopRate(progress: number): number {
  return 1 / (0.7 - 0.3 * progress);
}

/**
 * Where a winner ends up: they step out to the open strip at the front of the board, in their own
 * column, so nobody in a row in front of them hides them in the close-up.
 */
export function winnerSpot(layout: Layout, spot: Spot): { x: number; y: number; z: number } {
  const z = Math.min(layout.board.maxZ - 0.3, layout.rows[0].z + 0.8);
  return { x: spot.x, y: surfaceAt(layout, spot.x, z), z };
}

const damp = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * The camera: the fitted wide shot, and on a win a smooth push in to a close-up of the winner at
 * the front of the board (back to the wide shot on Reset). Reduced motion cuts instead of moving.
 */
function CameraRig({ base, show, layout, bottomInset, crownTops }: { base: RefObject<BasePose>; show: RefObject<Show>; layout: Layout; bottomInset: number; crownTops: Map<number, number> }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const height = useThree((s) => s.size.height);
  const blend = useRef(0);
  const v = useMemo(() => ({ focus: new THREE.Vector3(), close: new THREE.Vector3(), aim: new THREE.Vector3() }), []);
  useFrame((_, dt) => {
    const s = show.current;
    const b = base.current;
    if (!b.ready) return;
    const want = s.phase === "won" && s.winnerId !== null ? 1 : 0;
    blend.current = s.reducedMotion ? want : damp(blend.current, want, 2.4, Math.min(dt, 0.1));
    if (Math.abs(blend.current - want) < 1e-4) blend.current = want;
    const k = smooth(blend.current);
    // Frame the winner from the feet to above the crown and name tag, a little from above so the
    // crowd in front stays below the shot.
    let halfH = 2.5 * Math.max(0.85, layout.stageScale);
    // A winner whose crown would rise past that (tall hair, a hat, a tall build: avatar.tsx) gets a
    // taller shot, its bottom edge where it was.
    const crown = s.winnerId === null ? 0 : (crownTops.get(s.winnerId) ?? 0);
    // (+ 0.45 for the name tag riding just above the crown, + 0.3 for most of the winner's hop.)
    const extra = Math.max(0, (crown + 0.75) * WINNER_GROW * layout.stageScale - (1.25 * layout.stageScale + 0.68 * halfH));
    halfH += extra / 2;
    const dist = halfH / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const elevation = 0.36;
    v.focus.set(s.winnerX, s.winnerY + 1.25 * layout.stageScale + extra / 2, s.winnerZ);
    v.close.set(0, Math.sin(elevation), Math.cos(elevation)).multiplyScalar(dist).add(v.focus);
    // The control bar covers the bottom of the canvas: centre the winner in what is left.
    if (height > 0) v.focus.y -= (Math.min(bottomInset, height * 0.4) / height) * halfH;
    camera.position.lerpVectors(b.position, v.close, k);
    v.aim.lerpVectors(b.aim, v.focus, k);
    camera.lookAt(v.aim);
  });
  return null;
}

const WINNER_GROW = 1.3;

/**
 * The winner steps out of their row to the front of the board (a hop over anyone in front of them)
 * and back again on Reset. Moves the wrapper group around their avatar; the avatar itself is unchanged.
 */
function WinnerStep({
  show,
  layout,
  entrants,
  groups,
}: {
  show: RefObject<Show>;
  layout: Layout;
  entrants: StageEntrant[];
  groups: RefObject<Map<number, THREE.Group>>;
}) {
  const step = useRef<{ id: number | null; index: number; k: number }>({ id: null, index: -1, k: 0 });
  useFrame((_, dt) => {
    const s = show.current;
    const st = step.current;
    const winnerIndex = s.winnerId === null ? -1 : entrants.findIndex((e) => e.memberId === s.winnerId);
    const wanted = s.phase === "won" && winnerIndex >= 0 ? s.winnerId : null;
    const d = Math.min(dt, 0.1);
    if (st.id !== null && st.id !== wanted) {
      // Back to their own space (Reset), before anyone else may step out.
      st.k = s.reducedMotion ? 0 : Math.max(0, st.k - d / 0.7);
    } else if (wanted !== null) {
      if (st.id === null) Object.assign(st, { id: wanted, index: winnerIndex, k: 0 });
      st.k = s.reducedMotion ? 1 : Math.min(1, st.k + d / 0.9);
    }
    if (st.id === null) return;
    const group = groups.current.get(st.id);
    const spot = layout.stage[st.index];
    if (group && spot) {
      const to = winnerSpot(layout, spot);
      const e = easeInOutSine(st.k);
      // Higher hops from the back rows, which have more heads to clear.
      const arc = 4 * e * (1 - e) * (0.7 + 0.45 * spot.row);
      // A little bigger up front, scaled about their own feet: the star of the shot.
      const grow = 1 + (WINNER_GROW - 1) * e;
      group.scale.setScalar(grow);
      group.position.set(
        spot.x * (1 - grow),
        spot.y * (1 - grow) + (to.y - spot.y) * e + arc,
        spot.z * (1 - grow) + (to.z - spot.z) * e,
      );
    }
    if (st.k === 0 && st.id !== wanted) {
      group?.position.set(0, 0, 0);
      group?.scale.setScalar(1);
      st.id = null;
    }
  });
  return null;
}

/** Runs the spin: plans it from the already-drawn winner, eases the wheel there, reports the stop. */
function Director({
  spin,
  phase,
  entrants,
  layout,
  reducedMotion,
  show,
  ticker,
  onSpinEnd,
}: {
  spin: SpinRequest | null;
  phase: ShowPhase;
  entrants: StageEntrant[];
  layout: Layout;
  reducedMotion: boolean;
  show: RefObject<Show>;
  ticker: RefObject<HTMLDivElement | null>;
  onSpinEnd: (id: number) => void;
}) {
  const clock = useThree((s) => s.clock);
  const plan = useRef<{ id: number; plan: SpinPlan; startedAt: number } | null>(null);
  const lastSlice = useRef(-1);
  const endRef = useRef(onSpinEnd);
  endRef.current = onSpinEnd;

  useEffect(() => {
    show.current.reducedMotion = reducedMotion;
  }, [show, reducedMotion]);

  // A new spin request (a fresh object each time the page draws).
  useEffect(() => {
    if (!spin || phase !== "spinning" || entrants.length === 0) return;
    if (plan.current?.id === spin.id) return;
    const n = entrants.length;
    const single = n === 1;
    const turns = reducedMotion ? 0 : single ? 2 : 5;
    const duration = reducedMotion ? 1 : single ? 3 : 6.2 + Math.random() * 0.8;
    // Where in the winner's slice the pointer stops is cosmetic (the winner is already fixed).
    const offset = single ? 0 : (Math.random() * 2 - 1) * 0.6;
    const from = show.current.rotation;
    const to = landingRotation(from, spin.winnerIndex, n, turns, offset);
    plan.current = {
      id: spin.id,
      startedAt: clock.elapsedTime,
      plan: { from, to, duration, windup: reducedMotion ? 0 : 0.45, windupAngle: reducedMotion ? 0 : 0.22 },
    };
    const spot = layout.stage[spin.winnerIndex];
    // Where the winner will stand once they step forward (see WinnerStep).
    const stand = spot ? winnerSpot(layout, spot) : { x: 0, y: 0, z: 0 };
    Object.assign(show.current, {
      phase: "spinning",
      since: clock.elapsedTime,
      progress: 0,
      winnerId: entrants[spin.winnerIndex].memberId,
      winnerX: stand.x,
      winnerY: stand.y,
      winnerZ: stand.z,
    } satisfies Partial<Show>);
  }, [spin, phase, entrants, layout, reducedMotion, show, clock]);

  // Back to the start (Reset) or on to the celebration.
  useEffect(() => {
    const s = show.current;
    if (phase === "ready") {
      plan.current = null;
      Object.assign(s, { phase: "ready", since: clock.elapsedTime, progress: 1, winnerId: null, speed: 0 } satisfies Partial<Show>);
    } else if (phase === "won" && s.phase !== "won") {
      Object.assign(s, { phase: "won", since: clock.elapsedTime, progress: 1, speed: 0 } satisfies Partial<Show>);
    }
  }, [phase, show, clock]);

  useFrame((_, dt) => {
    const s = show.current;
    const current = plan.current;
    if (current && s.phase === "spinning") {
      const elapsed = clock.elapsedTime - current.startedAt;
      const before = s.rotation;
      s.rotation = spinRotation(current.plan, elapsed);
      s.speed = dt > 0 ? (s.rotation - before) / dt : 0;
      s.progress = spinProgress(current.plan, elapsed);
      // Integrate the hop tempo (see Show.hopBeat), so speeding up never makes the hops jump.
      s.hopBeat += dt * stageHopRate(s.progress);
      s.crowdBeat += dt * crowdHopRate(s.progress);
      if (elapsed >= current.plan.duration) {
        s.rotation = current.plan.to;
        s.speed = 0;
        s.phase = "won";
        s.since = clock.elapsedTime;
        plan.current = { ...current, startedAt: Number.POSITIVE_INFINITY };
        endRef.current(current.id);
      }
    }
    // The name under the pointer, live while spinning.
    const el = ticker.current;
    if (el && entrants.length > 0) {
      const i = sliceUnderPointer(s.rotation, entrants.length);
      if (i !== lastSlice.current) {
        lastSlice.current = i;
        el.textContent = entrants[i].displayName;
      }
    }
  });
  return null;
}

function WinnerLight({ show }: { show: RefObject<Show> }) {
  const light = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, dt) => {
    const s = show.current;
    const l = light.current;
    if (!l) return;
    const on = s.phase === "won" && s.winnerId !== null;
    if (on) {
      // On the spot the winner steps out to.
      l.position.set(s.winnerX, s.winnerY + 7, s.winnerZ + 3);
      target.position.set(s.winnerX, s.winnerY + 0.6, s.winnerZ);
      target.updateMatrixWorld();
    }
    const goal = on ? 5 : 0;
    l.intensity = s.reducedMotion ? goal : l.intensity + (goal - l.intensity) * (1 - Math.exp(-5 * dt));
  });
  return (
    <>
      <primitive object={target} />
      <spotLight ref={light} target={target} angle={0.22} penumbra={0.5} decay={0} intensity={0} color="#fff1c1" />
    </>
  );
}

interface SceneProps extends LotteryStageProps {
  layout: Layout;
  show: RefObject<Show>;
  base: RefObject<BasePose>;
  ticker: RefObject<HTMLDivElement | null>;
  labelLayer: RefObject<HTMLDivElement | null>;
  onHoverSlice: (i: number | null) => void;
  onHoverCrowd: (p: StagePerson | null) => void;
}

function Scene(props: SceneProps) {
  const { entrants, audience, phase, spin, reducedMotion, layout, show, base, ticker, labelLayer, onSpinEnd, onHoverSlice, onHoverCrowd } = props;
  // Each entrant's wrapper group, for WinnerStep to move the winner forward.
  const groups = useRef(new Map<number, THREE.Group>());
  const looks = useMemo(() => entrants.map((e) => resolveLook(e.memberId, e.avatar)), [entrants]);
  const crownTops = useMemo(() => new Map(entrants.map((e, i) => [e.memberId, figureMetrics(looks[i]).crownTop])), [entrants, looks]);
  const winnerId = phase === "won" && spin ? entrants[spin.winnerIndex]?.memberId : undefined;
  const { board, wheel } = layout;

  const volleys = useMemo<Volley[]>(() => {
    const from = spin ? layout.stage[spin.winnerIndex] : undefined;
    const spot = from ? winnerSpot(layout, from) : undefined;
    const list: Volley[] = [
      { origin: [board.minX + 0.4, board.top + 0.3, board.maxZ - 0.3], direction: [0.55, 1, -0.25], speed: 11, spread: 0.5, delay: 0 },
      { origin: [board.maxX - 0.4, board.top + 0.3, board.maxZ - 0.3], direction: [-0.55, 1, -0.25], speed: 11, spread: 0.5, delay: 0.05 },
      { origin: [0, wheel.y + wheel.radius + 1, wheel.z + 0.5], direction: [0, 0.6, 0.6], speed: 7, spread: 1.4, delay: 0.25 },
    ];
    if (spot) list.push({ origin: [spot.x, spot.y + 1.2, spot.z], direction: [0, 1, 0.15], speed: 9, spread: 0.7, delay: 0.1 });
    return list;
  }, [spin, layout, board, wheel]);
  const floorAt = useMemo(() => (x: number, z: number) => surfaceAt(layout, x, z), [layout]);

  return (
    <>
      <FitCamera points={layout.frame} bottomInset={props.bottomInset ?? 0} base={base} />
      <CameraRig base={base} show={show} layout={layout} bottomInset={props.bottomInset ?? 0} crownTops={crownTops} />
      <WinnerStep show={show} layout={layout} entrants={entrants} groups={groups} />
      <Director
        spin={spin}
        phase={phase}
        entrants={entrants}
        layout={layout}
        reducedMotion={reducedMotion}
        show={show}
        ticker={ticker}
        onSpinEnd={onSpinEnd}
      />
      <hemisphereLight args={["#dff1ff", "#ffe2c6", 1.3]} />
      <directionalLight
        position={[6, 14, 9]}
        intensity={2.1}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={board.minX - 3}
        shadow-camera-right={board.maxX + 3}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-camera-near={1}
        shadow-camera-far={60}
      />
      <WinnerLight show={show} />
      <Scenery layout={layout} reducedMotion={reducedMotion} />
      {entrants.length > 0 && (
        <Wheel
          entrants={entrants}
          show={show}
          position={[wheel.x, wheel.y, wheel.z]}
          radius={wheel.radius}
          onHoverSlice={onHoverSlice}
        />
      )}
      {entrants.map((e, i) => {
        const spot = layout.stage[i];
        return (
          <group
            key={e.memberId}
            ref={(g) => {
              if (g) groups.current.set(e.memberId, g);
              else groups.current.delete(e.memberId);
            }}
          >
            <Avatar
              name={e.displayName}
              postCount={e.postCount}
              look={looks[i]}
              position={[spot.x, spot.y, spot.z]}
              scale={layout.stageScale}
              labelLift={spot.labelLift}
              crowded={layout.crowded}
              isWinner={e.memberId === winnerId}
              show={show}
              labelLayer={labelLayer}
            />
          </group>
        );
      })}
      <Crowd people={audience} spots={layout.audience} scale={layout.audienceScale} show={show} onHover={onHoverCrowd} />
      {!reducedMotion && <Confetti burst={phase === "won" && spin ? spin.id : 0} volleys={volleys} floorAt={floorAt} />}
    </>
  );
}

export default function LotteryStage(props: LotteryStageProps) {
  const { entrants, audience, phase, label } = props;
  const layout = useMemo(() => layoutFor(entrants.length, audience.length), [entrants.length, audience.length]);
  const show = useRef<Show>({
    phase: "ready",
    since: 0,
    progress: 1,
    rotation: 0,
    speed: 0,
    winnerId: null,
    winnerX: 0,
    winnerY: 0,
    winnerZ: 0,
    hopBeat: 0,
    crowdBeat: 0,
    reducedMotion: props.reducedMotion,
  });
  const base = useRef<BasePose>({ ready: false, position: new THREE.Vector3(), aim: new THREE.Vector3() });
  const ticker = useRef<HTMLDivElement>(null);
  // Name tags go in their own layer: drei's Html otherwise re-parents every tag once the canvas
  // connects its events, remounting 40 React roots mid-render.
  const labelLayer = useRef<HTMLDivElement>(null);
  const [hoverSlice, setHoverSlice] = useState<number | null>(null);
  const [hoverCrowd, setHoverCrowd] = useState<StagePerson | null>(null);

  const hovered = hoverSlice != null ? entrants[hoverSlice] : undefined;
  return (
    <div className={`lottery-stage${entrants.length === 0 ? " empty-stage" : ""}${phase === "won" ? " won-shot" : ""}`}>
      <div className="lottery-canvas" role="img" aria-label={label}>
        <Canvas
          shadows="percentage"
          flat
          dpr={[1, 2]}
          camera={{ fov: 34, near: 0.1, far: 300, position: [0, 6, 22] }}
          gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        >
          <Scene
            {...props}
            layout={layout}
            show={show}
            base={base}
            ticker={ticker}
            labelLayer={labelLayer}
            onHoverSlice={setHoverSlice}
            onHoverCrowd={setHoverCrowd}
          />
        </Canvas>
        <div className="lottery-labels" ref={labelLayer} />
      </div>
      <div aria-hidden="true" className={`lottery-ticker${phase === "spinning" ? " on" : ""}`} ref={ticker} />
      {(hovered || hoverCrowd) && phase !== "spinning" && (
        <div aria-hidden="true" className="lottery-hover">
          {hovered ? (
            <>
              <strong>{hovered.displayName}</strong> · {hovered.postCount === 1 ? "1 post" : `${hovered.postCount} posts`}
            </>
          ) : (
            <>
              <strong>{hoverCrowd?.displayName}</strong> · {props.notPosted ?? "didn’t post this week"}
            </>
          )}
        </div>
      )}
    </div>
  );
}
