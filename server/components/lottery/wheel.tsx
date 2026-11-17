// The prize wheel: a chunky toy wheel on a stand, every entrant's name on a slice, a flapper
// pointer at the top and chasing bulbs around the rim. It only shows `show.rotation`; the spin
// itself is planned in stage.tsx from the already-drawn winner.
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { TAU, sliceAngle } from "./draw";
import { sliceColors } from "./look";
import { starGeometry } from "./shapes";
import type { Show, StageEntrant } from "./types";

/** Rounded-leaning system fonts only (no web font download); keep in step with --party-font in style.css. */
export const WHEEL_FONT = `ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Nunito", "Varela Round", system-ui, sans-serif`;

const TEX = 2048;
const INK = "#2b1d3a";

/** Fit `text` into `width` px with the context's current font, ending in an ellipsis if cut. */
function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid).trimEnd()}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "…" : `${text.slice(0, lo).trimEnd()}…`;
}

/** Paint the wheel face: slices clockwise from the top, names reading outward along each slice. */
function paintFace(canvas: HTMLCanvasElement, entrants: StageEntrant[]) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const c = TEX / 2;
  const r = c * 0.995;
  const n = entrants.length;
  const colors = sliceColors(n);
  ctx.clearRect(0, 0, TEX, TEX);
  ctx.lineJoin = "round";

  if (n === 1) {
    ctx.fillStyle = colors[0];
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TAU);
    ctx.fill();
    // Sunburst stripes, so a one-person wheel still visibly turns.
    ctx.fillStyle = "rgba(255,255,255,.16)";
    for (let k = 0; k < 16; k += 2) {
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, (k / 16) * TAU, ((k + 1) / 16) * TAU);
      ctx.fill();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    // Shrink the type before cutting the name: system fallbacks run wider than a rounded face.
    const room = r * 1.55;
    let size = 150;
    ctx.font = `700 ${size}px ${WHEEL_FONT}`;
    while (size > 90 && ctx.measureText(entrants[0].displayName).width > room) {
      size -= 6;
      ctx.font = `700 ${size}px ${WHEEL_FONT}`;
    }
    const name = fitText(ctx, entrants[0].displayName, room);
    // The spin stops with the slice's middle (the bottom of this texture) under the pointer, so
    // the name is painted there upside down and arrives at the top the right way up.
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(Math.PI);
    ctx.lineWidth = 34;
    ctx.strokeStyle = INK;
    ctx.strokeText(name, 0, -r * 0.48);
    ctx.fillStyle = "#fff";
    ctx.fillText(name, 0, -r * 0.48);
    ctx.restore();
    return;
  }

  const slice = sliceAngle(n);
  for (let i = 0; i < n; i++) {
    // Canvas angles run clockwise from +x; ours run clockwise from the top.
    const a0 = i * slice - Math.PI / 2;
    ctx.fillStyle = colors[i];
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, r, a0, a0 + slice);
    ctx.closePath();
    ctx.fill();
    // A soft highlight band near the rim for a moulded-plastic feel.
    const grad = ctx.createRadialGradient(c, c, r * 0.55, c, c, r);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(0.85, "rgba(255,255,255,.10)");
    grad.addColorStop(1, "rgba(0,0,0,.10)");
    ctx.fillStyle = grad;
    ctx.fill();
  }
  // Dividers.
  ctx.strokeStyle = "#fffaf0";
  ctx.lineWidth = n > 30 ? 6 : 10;
  for (let i = 0; i < n; i++) {
    const a = i * slice - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    ctx.stroke();
  }

  // Names: as large as the slice allows at mid-radius, capped so short lists don't shout.
  const inner = r * 0.25;
  const outer = r * 0.92;
  const chord = 2 * (r * 0.6) * Math.sin(Math.min(slice, Math.PI / 2) / 2);
  const px = Math.round(Math.max(28, Math.min(120, chord * 0.8)));
  ctx.font = `700 ${px}px ${WHEEL_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((i + 0.5) * slice - Math.PI / 2);
    const text = fitText(ctx, entrants[i].displayName, outer - inner);
    ctx.lineWidth = Math.max(6, px * 0.24);
    ctx.strokeStyle = INK;
    ctx.strokeText(text, outer, 0);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, outer, 0);
    ctx.restore();
  }
}

/** Which slice a point on the face is over, from its texture coordinates. */
function sliceAtUv(uv: THREE.Vector2, count: number): number {
  const x = uv.x - 0.5;
  const y = uv.y - 0.5;
  const clockwiseFromTop = (Math.atan2(x, y) + TAU) % TAU;
  return Math.min(count - 1, Math.floor(clockwiseFromTop / sliceAngle(count)));
}

const BULBS = 28;

export function Wheel({
  entrants,
  show,
  position,
  radius,
  onHoverSlice,
}: {
  entrants: StageEntrant[];
  show: RefObject<Show>;
  position: [number, number, number];
  radius: number;
  onHoverSlice: (index: number | null) => void;
}) {
  const spinner = useRef<THREE.Group>(null);
  const flapper = useRef<THREE.Group>(null);
  const bulbs = useRef<(THREE.Mesh | null)[]>([]);
  const n = entrants.length;

  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = TEX;
    canvas.height = TEX;
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);
  useEffect(() => {
    paintFace(texture.image as HTMLCanvasElement, entrants);
    texture.needsUpdate = true;
  }, [texture, entrants]);

  const mats = useMemo(
    () => ({
      bulbOn: new THREE.MeshStandardMaterial({ color: "#fff6c9", emissive: "#ffd34d", emissiveIntensity: 1.4 }),
      bulbOff: new THREE.MeshStandardMaterial({ color: "#f5e6b8", emissive: "#a8741a", emissiveIntensity: 0.15 }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  const thickness = 0.32;
  const ring = radius + 0.3;

  useFrame((state) => {
    const s = show.current;
    if (spinner.current) spinner.current.rotation.z = s.rotation;
    // The flapper leans as each divider peg pushes past it, then snaps back.
    if (flapper.current) {
      let lean = 0;
      if (n > 1 && s.phase === "spinning") {
        const slice = sliceAngle(n);
        const frac = ((((s.rotation % slice) + slice) % slice) / slice);
        const push = Math.min(1, Math.abs(s.speed) / 3);
        // Clockwise spin: the top of the wheel moves right, so the peg shoves the tip right (+z).
        lean = frac < 0.3 ? (1 - frac / 0.3) * 0.5 * push : 0;
      }
      flapper.current.rotation.z += (lean - flapper.current.rotation.z) * 0.5;
    }
    // Bulbs: a lazy twinkle at rest, a fast chase while spinning, everything blinking on a win.
    const t = state.clock.elapsedTime;
    for (let i = 0; i < BULBS; i++) {
      const b = bulbs.current[i];
      if (!b) continue;
      let on: boolean;
      if (s.reducedMotion) on = i % 2 === 0;
      else if (s.phase === "spinning") on = (i + Math.floor(t * 18)) % 4 < 2;
      else if (s.phase === "won") on = Math.floor(t * 4) % 2 === i % 2;
      else on = (i + Math.floor(t * 2.5)) % 3 !== 0;
      b.material = on ? mats.bulbOn : mats.bulbOff;
    }
  });

  const slice = n > 0 ? sliceAngle(n) : TAU;
  const pegs = n > 1 && n <= 64 ? Array.from({ length: n }, (_, i) => i * slice) : [];

  const hover = (e: ThreeEvent<PointerEvent>) => {
    if (e.uv && n > 0) onHoverSlice(sliceAtUv(e.uv, n));
  };

  return (
    <group position={position}>
      {/* Stand: two chunky legs and a rounded foot. */}
      <group position={[0, 0, -0.45]}>
        {[-1, 1].map((side) => (
          <mesh key={side} position={[side * 0.85, -radius * 0.62, 0]} rotation={[0, 0, side * 0.32]} castShadow>
            <capsuleGeometry args={[0.2, radius * 1.15, 8, 16]} />
            <meshStandardMaterial color="#8338ec" roughness={0.45} />
          </mesh>
        ))}
      </group>

      {/* The spinning part. */}
      <group ref={spinner}>
        <mesh rotation={[Math.PI / 2, 0, 0]} castShadow>
          <cylinderGeometry args={[radius, radius, thickness, 96]} />
          <meshStandardMaterial color="#fffaf0" roughness={0.5} />
        </mesh>
        <mesh
          position={[0, 0, thickness / 2 + 0.002]}
          onPointerMove={hover}
          onPointerOut={() => onHoverSlice(null)}
        >
          <circleGeometry args={[radius * 0.985, 128]} />
          <meshStandardMaterial map={texture} roughness={0.55} />
        </mesh>
        {pegs.map((a) => (
          <mesh
            key={a}
            position={[Math.sin(a) * radius * 0.94, Math.cos(a) * radius * 0.94, thickness / 2 + 0.08]}
            rotation={[Math.PI / 2, 0, 0]}
          >
            <cylinderGeometry args={[0.045, 0.045, 0.16, 10]} />
            <meshStandardMaterial color="#fffaf0" roughness={0.3} />
          </mesh>
        ))}
        {/* Hub with a star. */}
        <mesh position={[0, 0, thickness / 2]} scale={[1, 1, 0.55]}>
          <sphereGeometry args={[radius * 0.2, 32, 16]} />
          <meshStandardMaterial color="#fffaf0" roughness={0.35} />
        </mesh>
        <mesh position={[0, 0, thickness / 2 + radius * 0.11]} geometry={starGeometry()} scale={radius * 0.3}>
          <meshStandardMaterial color="#ffb703" roughness={0.3} emissive="#ff9f1c" emissiveIntensity={0.25} />
        </mesh>
      </group>

      {/* Fixed outer ring with bulbs. */}
      <mesh>
        <torusGeometry args={[ring, 0.2, 20, 96]} />
        <meshStandardMaterial color="#ff4d6d" roughness={0.4} />
      </mesh>
      {Array.from({ length: BULBS }, (_, i) => {
        const a = (i / BULBS) * TAU;
        return (
          <mesh
            key={i}
            ref={(m) => {
              bulbs.current[i] = m;
            }}
            position={[Math.sin(a) * ring, Math.cos(a) * ring, 0.17]}
            material={mats.bulbOff}
          >
            <sphereGeometry args={[0.085, 12, 8]} />
          </mesh>
        );
      })}

      {/* The pointer: a rounded gumdrop wedge hanging from the top of the ring, pivoting at its base. */}
      <group position={[0, ring + 0.12, 0.3]}>
        <group ref={flapper}>
          <mesh position={[0, -0.42, 0]} rotation={[0, 0, Math.PI]} castShadow>
            <coneGeometry args={[0.3, 0.75, 32]} />
            <meshStandardMaterial color="#ffb703" roughness={0.35} />
          </mesh>
          <mesh position={[0, -0.08, 0]}>
            <sphereGeometry args={[0.32, 24, 16]} />
            <meshStandardMaterial color="#ffb703" roughness={0.35} />
          </mesh>
          <mesh position={[0, -0.08, 0.27]} scale={0.12}>
            <sphereGeometry args={[1, 16, 12]} />
            <meshStandardMaterial color="#ffffff" roughness={0.2} />
          </mesh>
        </group>
      </group>
    </group>
  );
}
