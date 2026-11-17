// The cheap half of the plaza's people: everyone who is not online, drawn as instanced meshes (one
// draw call per part for the whole crowd, like the lottery's audience in ../lottery/crowd.tsx), and
// every star and high-five sparkle, also instanced. Online people and you are full characters
// (live-figure.tsx); their slots here are scaled to nothing.
//
// Wanderers face us, so unlike the lottery audience they get a face (eyes and a smile), arms,
// feet and their saved hair, in slightly muted colours, but no hats, brows or noses: enough to be
// recognisably them at plaza distance for a dozen draw calls instead of thirty per person.
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { figureMetrics } from "../lottery/avatar";
import { CrowdHair, type CrowdHairHandle } from "../lottery/crowd-hair";
import { type Look, muted } from "../lottery/look";
import { HAIR_TOP, characterGeometries, starGeometry } from "../lottery/shapes";
import type { PlazaSim } from "./sim";

/** Where a character's star sits (its centre) above their feet: over the hat or hair. */
export function starHeight(look: Look, full: boolean): number {
  const m = figureMetrics(look);
  const above = full ? m.above : (HAIR_TOP[look.hair] ?? 0) * look.headSize;
  return m.headTop + above + 0.36;
}

const PARTS = ["body", "belly", "head", "eyeL", "eyeR", "smile", "footL", "footR", "armL", "armR", "handL", "handR"] as const;
type Part = (typeof PARTS)[number];

const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const local = (pos: THREE.Vector3, scale: THREE.Vector3 | number = 1, euler = new THREE.Euler()) =>
  new THREE.Matrix4().compose(pos, new THREE.Quaternion().setFromEuler(euler), typeof scale === "number" ? v(scale, scale, scale) : scale);

/** Each part's transform relative to the figure's feet, mirroring ../lottery/avatar.tsx's Character. */
function partMatrices(look: Look): Record<Part, THREE.Matrix4> & { headSpace: THREE.Matrix4 } {
  const h = look.height;
  const g = look.girth;
  const hs = look.headSize;
  const { bodyCenter, neck } = figureMetrics(look);
  const belly = Math.min(1, (g / 0.9) ** 2);
  const headSpace = local(v(0, neck + 0.3 * hs, 0), hs);
  const inHead = (m: THREE.Matrix4) => headSpace.clone().multiply(m);
  const eyeX = 0.12 + 0.025 * look.eyeSpread;
  const arm = (side: 1 | -1) => local(v(side * 0.29 * g, neck - 0.14, 0), 1, new THREE.Euler(0, 0, side * 0.3));
  const armL = arm(1).multiply(local(v(0, -0.17, 0)));
  const armR = arm(-1).multiply(local(v(0, -0.17, 0)));
  const handL = arm(1).multiply(local(v(0, -0.32, 0), 1.05));
  const handR = arm(-1).multiply(local(v(0, -0.32, 0), 1.05));
  return {
    headSpace,
    body: local(v(0, bodyCenter, 0), v(g, h, g)),
    belly: local(v(0, bodyCenter - 0.05, 0.2 * g), v(0.42 * g, 0.5 * h, 0.25 * belly)),
    head: headSpace.clone(),
    eyeL: inHead(local(v(-eyeX, 0.05, 0.315), v(1, 1.25, 0.6))),
    eyeR: inHead(local(v(eyeX, 0.05, 0.315), v(1, 1.25, 0.6))),
    smile: inHead(local(v(0, -0.05, 0.33), 1, new THREE.Euler(0, 0, Math.PI))),
    footL: local(v(-0.15, 0.07, 0.06), v(1, 0.65, 1.3)),
    footR: local(v(0.15, 0.07, 0.06), v(1, 0.65, 1.3)),
    armL,
    armR,
    handL,
    handR,
  };
}

export function Wanderers({ sim, looks }: { sim: PlazaSim; looks: Look[] }) {
  const g = characterGeometries();
  const n = looks.length;
  const meshes = useRef<Partial<Record<Part, THREE.InstancedMesh | null>>>({});
  const hair = useRef<CrowdHairHandle>(null);
  const parts = useMemo(() => looks.map(partMatrices), [looks]);
  const mats = useMemo(
    () => ({
      tinted: new THREE.MeshStandardMaterial({ roughness: 0.6 }),
      ink: new THREE.MeshStandardMaterial({ color: "#2b1d3a", roughness: 0.3 }),
      belly: new THREE.MeshStandardMaterial({ color: "#f3efe9", roughness: 0.5 }),
    }),
    [],
  );
  useEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats]);

  // Slightly muted: still clearly them, but the online people (full colour, ringed) read first.
  useLayoutEffect(() => {
    const c = new THREE.Color();
    const paint = (part: Part, color: (l: Look) => string) => {
      const mesh = meshes.current[part];
      if (!mesh) return;
      looks.forEach((look, i) => mesh.setColorAt(i, c.set(color(look))));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    paint("body", (l) => muted(l.body, 0.22));
    paint("armL", (l) => muted(l.body, 0.22));
    paint("armR", (l) => muted(l.body, 0.22));
    paint("head", (l) => muted(l.head, 0.15));
    paint("handL", (l) => muted(l.head, 0.15));
    paint("handR", (l) => muted(l.head, 0.15));
    paint("footL", (l) => muted(l.accent, 0.22));
    paint("footR", (l) => muted(l.accent, 0.22));
  }, [looks]);

  const root = useMemo(() => new THREE.Matrix4(), []);
  const m = useMemo(() => new THREE.Matrix4(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const pos = useMemo(() => new THREE.Vector3(), []);
  const scl = useMemo(() => new THREE.Vector3(), []);
  const up = useMemo(() => new THREE.Vector3(0, 1, 0), []);

  useFrame(() => {
    for (const p of sim.people) {
      const i = p.index;
      const set = (part: Part, matrix: THREE.Matrix4) => meshes.current[part]?.setMatrixAt(i, matrix);
      if (p.mode !== "wander" || !parts[i]) {
        for (const part of PARTS) set(part, HIDDEN);
        hair.current?.place(i, HIDDEN);
        continue;
      }
      const wide = 1 / Math.sqrt(p.stretch);
      root.compose(pos.set(p.x, p.lift, p.z), q.setFromAxisAngle(up, p.yaw), scl.set(wide, p.stretch, wide));
      const pm = parts[i];
      for (const part of PARTS) set(part, m.multiplyMatrices(root, pm[part]));
      hair.current?.place(i, m.multiplyMatrices(root, pm.headSpace));
    }
    for (const part of PARTS) {
      const mesh = meshes.current[part];
      if (mesh) mesh.instanceMatrix.needsUpdate = true;
    }
    hair.current?.commit();
  });

  if (n === 0) return null;
  const geometry: Record<Part, THREE.BufferGeometry> = {
    body: g.body, belly: g.head, head: g.head, eyeL: g.eye, eyeR: g.eye, smile: g.smile,
    footL: g.foot, footR: g.foot, armL: g.limb, armR: g.limb, handL: g.ball, handR: g.ball,
  };
  const material = (part: Part) =>
    part === "eyeL" || part === "eyeR" || part === "smile" ? mats.ink : part === "belly" ? mats.belly : mats.tinted;
  return (
    <group>
      {PARTS.map((part) => (
        <instancedMesh
          key={`${part}:${n}`}
          ref={(mesh) => {
            meshes.current[part] = mesh;
          }}
          args={[geometry[part], material(part), n]}
          frustumCulled={false}
          castShadow={part === "body" || part === "head"}
        />
      ))}
      <CrowdHair ref={hair} looks={looks} />
    </group>
  );
}

/**
 * A gold star spinning over everyone who posted on LinkedIn this week, online or not, and the
 * sparkle ring of a high five.
 */
export function Stars({ sim, looks }: { sim: PlazaSim; looks: Look[] }) {
  const stars = useRef<THREE.InstancedMesh>(null);
  const sparks = useRef<THREE.InstancedMesh>(null);
  const heights = useMemo(() => looks.map((l) => ({ wander: starHeight(l, false), full: starHeight(l, true) })), [looks]);
  const gold = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#ffc93c", roughness: 0.25, metalness: 0.35, emissive: "#ff9f1c", emissiveIntensity: 0.4 }),
    [],
  );
  useEffect(() => () => gold.dispose(), [gold]);
  const o = useMemo(() => new THREE.Object3D(), []);

  useFrame(() => {
    const t = sim.t;
    const s = stars.current;
    if (s) {
      for (const p of sim.people) {
        const h = heights[p.index];
        if (!p.posted || !h) {
          s.setMatrixAt(p.index, HIDDEN);
          continue;
        }
        o.position.set(p.x, p.lift + (p.mode === "wander" ? h.wander : h.full) + 0.04 * Math.sin(t * 2 + p.index), p.z);
        // Facing the camera with a gentle wobble: a full spin shows it edge-on half the time.
        o.rotation.set(-0.35, sim.reducedMotion ? 0 : 0.55 * Math.sin(t * 1.8 + p.index), 0);
        o.scale.setScalar(0.46);
        o.updateMatrix();
        s.setMatrixAt(p.index, o.matrix);
      }
      s.instanceMatrix.needsUpdate = true;
    }
    const sp = sparks.current;
    if (sp) {
      let k = 0;
      for (const b of sim.bursts.slice(-SPARK_BURSTS)) {
        const pa = sim.byId.get(b.a);
        const pb = sim.byId.get(b.b);
        if (!pa || !pb) continue;
        const e = Math.min(1, (t - b.at) / 1.5);
        const r = 0.3 + 1.4 * Math.sqrt(e);
        for (let i = 0; i < SPARKS; i++) {
          const a = (i / SPARKS) * Math.PI * 2 + e;
          o.position.set((pa.x + pb.x) / 2 + Math.cos(a) * r, 1.5 + Math.sin(a) * r * 0.6 + e * 0.5, (pa.z + pb.z) / 2);
          o.rotation.set(0, 0, a + t * 4);
          o.scale.setScalar(0.22 * (1 - e * e));
          o.updateMatrix();
          sp.setMatrixAt(k++, o.matrix);
        }
      }
      for (; k < SPARKS * SPARK_BURSTS; k++) sp.setMatrixAt(k, HIDDEN);
      sp.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <>
      <instancedMesh key={`stars:${looks.length}`} ref={stars} args={[starGeometry(), gold, Math.max(1, looks.length)]} frustumCulled={false} />
      <instancedMesh ref={sparks} args={[starGeometry(), gold, SPARKS * SPARK_BURSTS]} frustumCulled={false} />
    </>
  );
}

const SPARKS = 10;
const SPARK_BURSTS = 3;
