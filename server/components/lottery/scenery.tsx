// The set: a lawn, a chunky board-game stage ringed with coloured spaces, a raised space under each
// entrant (back rows on higher tiers), puffy clouds and a few balloons. Original, simple shapes.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { PARTY } from "./look";
import type { Layout } from "./layout";

const roundedBox = new RoundedBoxGeometry(1, 1, 1, 3, 0.14);

/** Board spaces around the stage edge, like the path on a game board. */
function pathAround(board: Layout["board"], step: number): [number, number][] {
  const inset = 0.42;
  const x0 = board.minX + inset;
  const x1 = board.maxX - inset;
  const z0 = board.minZ + inset;
  const z1 = board.maxZ - inset;
  const out: [number, number][] = [];
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.round(len / step));
    for (let i = 0; i < n; i++) out.push([ax + ((bx - ax) * i) / n, az + ((bz - az) * i) / n]);
  };
  edge(x0, z1, x1, z1); // front, left to right
  edge(x1, z1, x1, z0);
  edge(x1, z0, x0, z0);
  edge(x0, z0, x0, z1);
  return out;
}

function Tiles({ layout }: { layout: Layout }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tiles = useMemo(() => {
    const list: { x: number; y: number; z: number; w: number; h: number; d: number; color: string }[] = [];
    pathAround(layout.board, 0.82).forEach(([x, z], i) => {
      list.push({ x, y: layout.board.top + 0.04, z, w: 0.66, h: 0.12, d: 0.66, color: i % 5 === 0 ? "#fffaf0" : PARTY[i % PARTY.length] });
    });
    // A raised space under each entrant; back rows are taller, like bleacher steps.
    layout.stage.forEach((spot) => {
      const h = spot.y - layout.board.top + 0.02;
      list.push({
        x: spot.x,
        y: layout.board.top + h / 2 - 0.02,
        z: spot.z,
        w: layout.spacing * 0.86 * layout.stageScale,
        h,
        d: 0.95,
        color: ["#ffd6e0", "#cdeffd", "#fff1b8", "#d8f8e4", "#e9ddff"][(spot.row + spot.col) % 5],
      });
    });
    return list;
  }, [layout]);

  useEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Object3D();
    const c = new THREE.Color();
    tiles.forEach((t, i) => {
      m.position.set(t.x, t.y, t.z);
      m.scale.set(t.w, t.h, t.d);
      m.updateMatrix();
      mesh.setMatrixAt(i, m.matrix);
      mesh.setColorAt(i, c.set(t.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tiles]);

  return (
    <instancedMesh key={tiles.length} ref={ref} args={[roundedBox, undefined, tiles.length]} receiveShadow castShadow>
      <meshStandardMaterial roughness={0.45} />
    </instancedMesh>
  );
}

function Cloud({ position, scale, drift }: { position: [number, number, number]; scale: number; drift: number }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (ref.current && drift) ref.current.position.x = position[0] + Math.sin(state.clock.elapsedTime * 0.05 * drift + position[1]) * 1.5;
  });
  return (
    <group ref={ref} position={position} scale={scale}>
      {[
        [0, 0, 0, 1],
        [0.9, -0.2, 0.1, 0.75],
        [-0.95, -0.25, 0, 0.7],
        [0.35, 0.45, -0.1, 0.7],
        [-0.4, 0.35, 0.1, 0.6],
      ].map(([x, y, z, r], i) => (
        <mesh key={i} position={[x, y, z]} scale={[r * 1.2, r, r]}>
          <sphereGeometry args={[0.8, 20, 14]} />
          <meshStandardMaterial color="#ffffff" roughness={0.9} emissive="#ffffff" emissiveIntensity={0.25} />
        </mesh>
      ))}
    </group>
  );
}

function Balloons({ position, colors, animate }: { position: [number, number, number]; colors: string[]; animate: boolean }) {
  const ref = useRef<THREE.Group>(null);
  useFrame((state) => {
    if (!ref.current || !animate) return;
    const t = state.clock.elapsedTime;
    ref.current.children.forEach((child, i) => {
      child.position.y = 2.1 + i * 0.25 + Math.sin(t * 1.4 + i * 2) * 0.08;
      child.rotation.z = Math.sin(t * 0.9 + i) * 0.06;
    });
  });
  return (
    <group position={position}>
      <group ref={ref}>
        {colors.map((color, i) => {
          const a = (i / colors.length) * Math.PI * 2;
          return (
            <group key={i} position={[Math.cos(a) * 0.32, 2.1 + i * 0.25, Math.sin(a) * 0.32]}>
              <mesh scale={[0.42, 0.5, 0.42]} castShadow>
                <sphereGeometry args={[1, 24, 18]} />
                <meshStandardMaterial color={color} roughness={0.25} />
              </mesh>
              <mesh position={[0, -0.52, 0]} scale={0.07}>
                <coneGeometry args={[1, 1.2, 8]} />
                <meshStandardMaterial color={color} roughness={0.25} />
              </mesh>
              <mesh position={[0, -1.4, 0]}>
                <cylinderGeometry args={[0.008, 0.008, 1.7, 4]} />
                <meshStandardMaterial color="#ffffff" />
              </mesh>
            </group>
          );
        })}
      </group>
    </group>
  );
}

export function Scenery({ layout, reducedMotion }: { layout: Layout; reducedMotion: boolean }) {
  const { board, wheel } = layout;
  const w = board.maxX - board.minX;
  const d = board.maxZ - board.minZ;
  const cx = (board.minX + board.maxX) / 2;
  const cz = (board.minZ + board.maxZ) / 2;
  return (
    <group>
      {/* Lawn */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, cz + 2]} receiveShadow>
        <circleGeometry args={[Math.max(w, d) * 1.6 + 8, 64]} />
        <meshStandardMaterial color="#9be7b0" roughness={0.95} />
      </mesh>
      {/* The board itself: a thick rounded slab with a contrasting skirt. */}
      <mesh geometry={roundedBox} position={[cx, board.top / 2, cz]} scale={[w + 0.3, board.top, d + 0.3]} receiveShadow castShadow>
        <meshStandardMaterial color="#7b5cff" roughness={0.5} />
      </mesh>
      <mesh geometry={roundedBox} position={[cx, board.top - 0.06, cz]} scale={[w, 0.16, d]} receiveShadow>
        <meshStandardMaterial color="#fff4dc" roughness={0.6} />
      </mesh>
      <Tiles layout={layout} />
      <Cloud position={[-wheel.radius * 2.6, wheel.y + 1.2, wheel.z - 5]} scale={1.3} drift={reducedMotion ? 0 : 1} />
      <Cloud position={[wheel.radius * 2.9, wheel.y + 0.4, wheel.z - 6]} scale={1.6} drift={reducedMotion ? 0 : 0.8} />
      <Cloud position={[wheel.radius * 0.9, wheel.y + 3, wheel.z - 9]} scale={1.1} drift={reducedMotion ? 0 : 1.2} />
      <Cloud position={[-wheel.radius * 1.2, wheel.y - 1.8, wheel.z - 10]} scale={1.4} drift={reducedMotion ? 0 : 0.6} />
      <Balloons position={[board.minX + 0.35, board.top, board.maxZ - 0.35]} colors={["#ff4d6d", "#ffb703", "#3a86ff"]} animate={!reducedMotion} />
      <Balloons position={[board.maxX - 0.35, board.top, board.maxZ - 0.35]} colors={["#06d6a0", "#ff70a6", "#8338ec"]} animate={!reducedMotion} />
    </group>
  );
}

/** Height of the surface at (x, z): the board top on the board, the lawn elsewhere. */
export function surfaceAt(layout: Layout, x: number, z: number): number {
  const { board } = layout;
  if (x >= board.minX && x <= board.maxX && z >= board.minZ && z <= board.maxZ) {
    for (const spot of layout.stage) {
      if (Math.abs(x - spot.x) < layout.spacing * 0.43 * layout.stageScale && Math.abs(z - spot.z) < 0.47) return spot.y;
    }
    return board.top + 0.1;
  }
  return 0;
}
