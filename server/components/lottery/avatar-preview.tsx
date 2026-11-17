// The avatar editor's live preview (loaded lazily by app/me/avatar/page.tsx, so three.js only
// downloads there): your character on a little round stage, idly bobbing like it does at the
// lottery while it waits. Drag (or use the arrow keys, or Turn around) to see it from any side.
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { Character, figureMetrics, hop, useCharacterMaterials, useCharacterRig } from "./avatar";
import type { Look } from "./look";

const damp = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

function Figure({ look, yaw, reducedMotion }: { look: Look; yaw: { current: number }; reducedMotion: boolean }) {
  const mats = useCharacterMaterials(look);
  const rig = useCharacterRig();
  const turntable = useRef<THREE.Group>(null);
  const shown = useRef(yaw.current);

  // The stage's "ready" idle (avatar.tsx): breathe, sway, arms bob, and now and then a hop.
  useFrame((state, dt) => {
    const t = state.clock.elapsedTime;
    const ph = look.phase;
    shown.current = reducedMotion ? yaw.current : damp(shown.current, yaw.current, 10, dt);
    if (turntable.current) turntable.current.rotation.y = shown.current;
    let lift = 0;
    let stretch = 1;
    let sway = 0;
    let armUp = 0.25;
    if (!reducedMotion) {
      stretch = 1 + 0.035 * Math.sin(t * 2.2 + ph);
      sway = 0.05 * Math.sin(t * 1.3 + ph);
      armUp = 0.3 + 0.1 * Math.sin(t * 2.2 + ph);
      const local = t % 5;
      if (local > 4.4) {
        const k = hop((local - 4.4) / 0.6);
        lift = k.lift * 0.22;
        stretch = k.stretch;
      }
    }
    const m = rig.mover.current;
    if (m) {
      m.position.y = lift;
      const wide = 1 / Math.sqrt(stretch);
      m.scale.set(wide, stretch, wide);
      m.rotation.set(0, 0, sway);
    }
    rig.armL.current?.rotation.set(0, 0, armUp);
    rig.armR.current?.rotation.set(0, 0, -armUp);
  });

  return (
    <group ref={turntable}>
      <Character look={look} rig={rig} mats={mats} />
    </group>
  );
}

/**
 * Frames the whole character, hat and hair included, with room for the name tag above it, at any
 * canvas shape. The camera keeps one height and distance per look so changing a hat re-frames.
 */
function FitCamera({ look }: { look: Look }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const { headTop, above } = figureMetrics(look);
  // Hops and the bob reach a little higher; the platform's rim is at about -0.2.
  const top = headTop + above + 0.3;
  const bottom = -0.25;
  useLayoutEffect(() => {
    if (!width || !height) return;
    camera.aspect = width / height;
    const half = THREE.MathUtils.degToRad(camera.fov / 2);
    const tagRoom = 56 / height; // the name tag over the top of the canvas
    const needV = (top - bottom) / 2 / Math.tan(half) / (1 - tagRoom);
    const needH = 0.8 / (Math.tan(half) * camera.aspect); // the figure and most of the platform
    const dist = Math.max(needV, needH) * 1.08;
    const mid = (top + bottom) / 2 + (top - bottom) * tagRoom * 0.5;
    camera.position.set(0, mid + dist * 0.22, dist);
    camera.lookAt(0, mid, 0);
    camera.updateProjectionMatrix();
  }, [camera, width, height, top]);
  return null;
}

const STEP = Math.PI / 8;

export default function AvatarPreview({
  look,
  name,
  reducedMotion,
}: {
  look: Look;
  name: string;
  reducedMotion: boolean;
}) {
  const yaw = useRef(-0.35); // a three-quarter view to start
  const drag = useRef<{ x: number; yaw: number; id: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    drag.current = { x: e.clientX, yaw: yaw.current, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    yaw.current = d.yaw + (e.clientX - d.x) * 0.012;
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id === e.pointerId) drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") yaw.current -= STEP;
    else if (e.key === "ArrowRight") yaw.current += STEP;
    else return;
    e.preventDefault();
  };

  return (
    <div className="avatar-preview">
      <div
        className="avatar-preview-canvas"
        role="img"
        aria-label={`Preview of your avatar. Drag sideways, or focus it and use the left and right arrow keys, to turn it around.`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        <Canvas
          shadows="percentage"
          flat
          dpr={[1, 2]}
          camera={{ fov: 30, near: 0.1, far: 50, position: [0, 1.45, 4.6] }}
          gl={{ antialias: true, alpha: true }}
        >
          <hemisphereLight args={["#dff1ff", "#ffe2c6", 1.3]} />
          <directionalLight position={[3, 7, 5]} intensity={2.1} castShadow shadow-mapSize={[1024, 1024]} shadow-bias={-0.0004} />
          <FitCamera look={look} />
          <Figure look={look} yaw={yaw} reducedMotion={reducedMotion} />
          {/* A round board-game space to stand on */}
          <mesh position={[0, -0.09, 0]} receiveShadow>
            <cylinderGeometry args={[0.95, 1.0, 0.18, 48]} />
            <meshStandardMaterial color="#ffd166" roughness={0.5} />
          </mesh>
          <mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <ringGeometry args={[0.72, 0.84, 48]} />
            <meshStandardMaterial color="#ffffff" roughness={0.6} />
          </mesh>
        </Canvas>
        <div className="avatar-preview-tag lottery-tag" aria-hidden="true">
          <span className="lottery-tag-name">{name}</span>
        </div>
      </div>
      <button type="button" className="avatar-turn" onClick={() => (yaw.current += Math.PI)}>
        Turn around
      </button>
    </div>
  );
}
