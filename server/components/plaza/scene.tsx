// The 3D plaza (loaded lazily by app/plaza/page.tsx, so three.js only downloads on that page): a
// board-game square on a lawn, with everyone on the roster in it. The page owns the sim and the
// live connection; this draws them. Per-frame work happens in refs and imperative DOM writes (the
// name tags, bubbles and "High five!" pops are positioned here every frame), never React state.
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { type AvatarInput } from "../lottery/avatar-model";
import { PARTY, type Look, resolveLook } from "../lottery/look";
import { Balloons, Cloud } from "../lottery/scenery";
import { LiveFigure } from "./live-figure";
import { HALF_D, HALF_W, type PlazaSim } from "./sim";
import { Stars, Wanderers, starHeight } from "./wanderers";

export interface PlazaPerson {
  id: number;
  name: string;
  avatar: AvatarInput | null;
}

/** Frame timings the page's debug handle reports (milliseconds between frames, a ring buffer). */
export interface FrameStats {
  frames: Float32Array;
  count: number;
  drawCalls: number;
  triangles: number;
}

export interface PlazaStageProps {
  sim: PlazaSim;
  /** In the sim's order (sim.people[i] is people[i]). */
  people: PlazaPerson[];
  /** Who is drawn as a full character besides you (the room's online members). */
  onlineIds: number[];
  reducedMotion: boolean;
  label: string;
  stats: FrameStats;
}

// --- the set -----------------------------------------------------------------------------------

const roundedBox = new RoundedBoxGeometry(1, 1, 1, 3, 0.14);

function EdgeTiles() {
  const ref = useRef<THREE.InstancedMesh>(null);
  const tiles = useMemo(() => {
    const out: { x: number; z: number; color: string }[] = [];
    const x0 = -HALF_W - 0.25;
    const x1 = HALF_W + 0.25;
    const z0 = -HALF_D - 0.25;
    const z1 = HALF_D + 0.25;
    const edge = (ax: number, az: number, bx: number, bz: number) => {
      const n = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.9));
      for (let i = 0; i < n; i++) out.push({ x: ax + ((bx - ax) * i) / n, z: az + ((bz - az) * i) / n, color: "" });
    };
    edge(x0, z1, x1, z1);
    edge(x1, z1, x1, z0);
    edge(x1, z0, x0, z0);
    edge(x0, z0, x0, z1);
    out.forEach((t, i) => (t.color = i % 5 === 0 ? "#fffaf0" : PARTY[i % PARTY.length]));
    return out;
  }, []);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const o = new THREE.Object3D();
    const c = new THREE.Color();
    tiles.forEach((t, i) => {
      o.position.set(t.x, 0.0, t.z);
      o.scale.set(0.72, 0.1, 0.72);
      o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
      mesh.setColorAt(i, c.set(t.color));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [tiles]);
  return (
    <instancedMesh ref={ref} args={[roundedBox, undefined, tiles.length]} receiveShadow>
      <meshStandardMaterial roughness={0.45} />
    </instancedMesh>
  );
}

/** A painted sunburst in the middle of the square (flat: people walk over it). */
function Medallion() {
  const rings = [
    { r: [2.3, 2.6], color: "#ffb703" },
    { r: [1.7, 2.3], color: "#fff4dc" },
    { r: [1.45, 1.7], color: "#ff70a6" },
    { r: [0.0, 1.45], color: "#cdeffd" },
  ];
  return (
    <group position={[0, 0.006, 0]}>
      {rings.map(({ r, color }, i) => (
        <mesh key={i} rotation={[-Math.PI / 2, 0, 0]} receiveShadow position={[0, i * 0.001, 0]}>
          <ringGeometry args={[r[0], r[1], 64]} />
          <meshStandardMaterial color={color} roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function Bushes() {
  const spots = useMemo(() => {
    const out: [number, number, number][] = [];
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + 0.2;
      out.push([Math.cos(a) * (HALF_W + 3.2 + (i % 3)), 0.35 + (i % 2) * 0.15, Math.sin(a) * (HALF_D + 3 + ((i * 7) % 3))]);
    }
    return out;
  }, []);
  return (
    <>
      {spots.map(([x, s, z], i) => (
        <mesh key={i} position={[x, s * 0.8, z]} scale={[s * 1.5, s * 1.2, s * 1.5]} castShadow>
          <sphereGeometry args={[0.9, 16, 12]} />
          <meshStandardMaterial color={i % 3 === 0 ? "#5fd08a" : "#73dc98"} roughness={0.9} />
        </mesh>
      ))}
    </>
  );
}

function Square({ reducedMotion }: { reducedMotion: boolean }) {
  const w = HALF_W * 2 + 1.4;
  const d = HALF_D * 2 + 1.4;
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.2, 0]} receiveShadow>
        <circleGeometry args={[60, 64]} />
        <meshStandardMaterial color="#9be7b0" roughness={0.95} />
      </mesh>
      <mesh geometry={roundedBox} position={[0, -0.26, 0]} scale={[w + 0.4, 0.4, d + 0.4]} receiveShadow>
        <meshStandardMaterial color="#7b5cff" roughness={0.5} />
      </mesh>
      <mesh geometry={roundedBox} position={[0, -0.06, 0]} scale={[w, 0.12, d]} receiveShadow>
        <meshStandardMaterial color="#fff4dc" roughness={0.65} />
      </mesh>
      <EdgeTiles />
      <Medallion />
      <Bushes />
      <Balloons position={[-HALF_W - 0.25, 0, -HALF_D - 0.25]} colors={["#ff4d6d", "#ffb703", "#3a86ff"]} animate={!reducedMotion} />
      <Balloons position={[HALF_W + 0.25, 0, -HALF_D - 0.25]} colors={["#06d6a0", "#ff70a6", "#8338ec"]} animate={!reducedMotion} />
      <Cloud position={[-9, 6.5, -HALF_D - 9]} scale={1.8} drift={reducedMotion ? 0 : 1} />
      <Cloud position={[7, 7.5, -HALF_D - 11]} scale={2.2} drift={reducedMotion ? 0 : 0.8} />
      <Cloud position={[0, 5.5, -HALF_D - 7]} scale={1.3} drift={reducedMotion ? 0 : 1.2} />
    </group>
  );
}

// --- the director: sim, camera, tags --------------------------------------------------------------

interface TagEl {
  wrap: HTMLDivElement;
  bubble: HTMLDivElement;
  tag: HTMLDivElement;
  width: number;
  height: number;
  shownBubble: string | null;
  opacity: number;
}

const ELEVATION = 0.6;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function Director({
  sim,
  looks,
  tags,
  layer,
  reducedMotion,
  stats,
}: {
  sim: PlazaSim;
  looks: Look[];
  tags: RefObject<Map<number, TagEl>>;
  layer: RefObject<HTMLDivElement | null>;
  reducedMotion: boolean;
  stats: FrameStats;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const heights = useMemo(() => looks.map((l) => ({ wander: starHeight(l, false), full: starHeight(l, true) })), [looks]);
  const st = useMemo(
    () => ({
      focus: new THREE.Vector3(),
      aim: new THREE.Vector3(),
      want: new THREE.Vector3(),
      v: new THREE.Vector3(),
      ready: false,
      bursts: new Map<number, HTMLDivElement>(),
      placed: [] as { x0: number; x1: number; y0: number; y1: number }[],
      order: [] as { el: TagEl; x: number; y: number; prio: number; alpha: number }[],
    }),
    [],
  );
  useEffect(() => {
    sim.reducedMotion = reducedMotion;
  }, [sim, reducedMotion]);
  useEffect(() => {
    const bursts = st.bursts;
    return () => {
      for (const el of bursts.values()) el.remove();
      bursts.clear();
    };
  }, [st]);

  useFrame((_, dt) => {
    // Frame timing and the last frame's draw calls (gl.info resets as each frame renders).
    stats.frames[stats.count % stats.frames.length] = dt * 1000;
    stats.count += 1;
    stats.drawCalls = gl.info.render.calls;
    stats.triangles = gl.info.render.triangles;

    sim.step(dt);

    // Camera: follow you from above and in front, wide enough to see a good stretch of the square.
    const me = sim.me;
    const aspect = size.width / Math.max(1, size.height);
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const dist = clamp(8.5 / (tanHalf * aspect), 11, 24);
    st.focus.set(me ? me.x : 0, 1, me ? me.z : 0);
    st.want.set(st.focus.x, st.focus.y + Math.sin(ELEVATION) * dist, st.focus.z + Math.cos(ELEVATION) * dist);
    if (!st.ready || reducedMotion) {
      camera.position.copy(st.want);
      st.aim.copy(st.focus);
      st.ready = true;
    } else {
      const k = 1 - Math.exp(-4 * Math.min(dt, 0.1));
      camera.position.lerp(st.want, k);
      st.aim.lerp(st.focus, k);
    }
    camera.lookAt(st.aim);
    camera.updateMatrixWorld();

    // Name tags and bubbles: project, then decide who shows. You, anyone talking and everyone
    // online always do; wanderers fade with distance from you and give way where tags would overlap.
    const map = tags.current;
    if (!map) return;
    const w = size.width;
    const h = size.height;
    st.order.length = 0;
    for (const p of sim.people) {
      const el = map.get(p.id);
      const hh = heights[p.index];
      if (!el || !hh) continue;
      if (el.shownBubble !== p.bubble) {
        el.bubble.textContent = p.bubble ?? "";
        el.bubble.classList.toggle("on", p.bubble !== null);
        el.shownBubble = p.bubble;
        el.width = 0;
      }
      const top = (p.mode === "wander" ? hh.wander : hh.full) + (p.posted ? 0.26 : -0.18);
      st.v.set(p.x, p.lift + top, p.z).project(camera);
      const x = ((st.v.x + 1) / 2) * w;
      const y = ((1 - st.v.y) / 2) * h;
      const inView = st.v.z < 1 && x > -60 && x < w + 60 && y > -40 && y < h + 80;
      const d = me ? Math.hypot(p.x - me.x, p.z - me.z) : 0;
      const prio = p.mode === "me" ? 0 : p.bubble ? 1 : p.mode === "online" ? 2 : 3 + d;
      const alpha = !inView ? 0 : prio < 3 ? 1 : clamp((10 - d) / 3, 0, 1);
      st.order.push({ el, x, y, prio, alpha });
    }
    st.order.sort((a, b) => a.prio - b.prio);
    st.placed.length = 0;
    for (const o of st.order) {
      const { el } = o;
      let alpha = o.alpha;
      let y = o.y;
      if (alpha > 0) {
        if (!el.width) {
          el.width = Math.max(el.tag.offsetWidth, el.shownBubble ? el.bubble.offsetWidth : 0) || 80;
          el.height = el.wrap.offsetHeight || 22;
        }
        const half = el.width / 2 + 3;
        const r = { x0: o.x - half, x1: o.x + half, y0: y - el.height - 2, y1: y };
        const hitOf = () => st.placed.find((q) => r.x0 < q.x1 && r.x1 > q.x0 && r.y0 < q.y1 && r.y1 > q.y0);
        let hit = hitOf();
        if (hit && o.prio >= 3) alpha = 0;
        else {
          // You, anyone talking and everyone online always show: stack up out of the way instead.
          for (let i = 0; hit && i < 6; i++, hit = hitOf()) {
            const up = r.y1 - hit.y0;
            r.y0 -= up;
            r.y1 -= up;
            y -= up;
          }
          st.placed.push(r);
        }
      }
      el.wrap.style.transform = `translate(${o.x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -100%)`;
      const a = Math.round(alpha * 20) / 20;
      if (a !== el.opacity) {
        el.opacity = a;
        el.wrap.style.opacity = String(a);
        el.wrap.style.visibility = a === 0 ? "hidden" : "visible";
      }
      el.wrap.style.zIndex = String(o.prio < 3 ? 30 - Math.floor(o.prio) * 5 : 10);
    }

    // "High five!" pops under the two, while the sparkles fly (wanderers.tsx).
    const live = new Set<number>();
    for (const b of sim.bursts) {
      const pa = sim.byId.get(b.a);
      const pb = sim.byId.get(b.b);
      if (!pa || !pb) continue;
      live.add(b.key);
      let el = st.bursts.get(b.key);
      if (!el && layer.current) {
        el = document.createElement("div");
        el.className = "plaza-five";
        el.textContent = "High five!";
        layer.current.appendChild(el);
        st.bursts.set(b.key, el);
      }
      if (!el) continue;
      // Under their feet, so the raised hands stay in view.
      st.v.set((pa.x + pb.x) / 2, 0, (pa.z + pb.z) / 2 + 0.35).project(camera);
      el.style.transform = `translate(${(((st.v.x + 1) / 2) * w).toFixed(1)}px, ${(((1 - st.v.y) / 2) * h).toFixed(1)}px) translate(-50%, 0)`;
    }
    for (const [key, el] of st.bursts) {
      if (!live.has(key)) {
        el.remove();
        st.bursts.delete(key);
      }
    }
  });
  return null;
}

// --- the stage ----------------------------------------------------------------------------------

export default function PlazaStage({ sim, people, onlineIds, reducedMotion, label, stats }: PlazaStageProps) {
  // Looks are kept per member while their avatar is unchanged, so a roster refetch rebuilds nothing
  // (a full character's materials are made from its look).
  const lookCache = useRef(new Map<number, { key: string; look: Look }>());
  const looks = useMemo(
    () =>
      people.map((p) => {
        const key = JSON.stringify(p.avatar);
        const hit = lookCache.current.get(p.id);
        if (hit && hit.key === key) return hit.look;
        const look = resolveLook(p.id, p.avatar);
        lookCache.current.set(p.id, { key, look });
        return look;
      }),
    [people],
  );
  const lookOf = useMemo(() => new Map(people.map((p, i) => [p.id, looks[i]])), [people, looks]);
  const tags = useRef(new Map<number, TagEl>());
  const layer = useRef<HTMLDivElement>(null);
  const live = useMemo(() => {
    const ids = new Set(onlineIds);
    ids.add(sim.meId);
    return [...ids].filter((id) => lookOf.has(id));
  }, [onlineIds, sim, lookOf]);
  const online = useMemo(() => new Set(onlineIds), [onlineIds]);

  return (
    <div className="plaza-canvas" role="img" aria-label={label}>
      <Canvas
        shadows="percentage"
        flat
        dpr={[1, 2]}
        camera={{ fov: 38, near: 0.1, far: 200, position: [0, 12, 14] }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <hemisphereLight args={["#dff1ff", "#ffe2c6", 1.3]} />
        <directionalLight
          position={[6, 16, 10]}
          intensity={2.1}
          castShadow
          shadow-mapSize={[2048, 2048]}
          shadow-bias={-0.0004}
          shadow-camera-left={-HALF_W - 4}
          shadow-camera-right={HALF_W + 4}
          shadow-camera-top={HALF_D + 6}
          shadow-camera-bottom={-HALF_D - 6}
          shadow-camera-near={1}
          shadow-camera-far={60}
        />
        <Director sim={sim} looks={looks} tags={tags} layer={layer} reducedMotion={reducedMotion} stats={stats} />
        <Square reducedMotion={reducedMotion} />
        <Wanderers sim={sim} looks={looks} />
        <Stars sim={sim} looks={looks} />
        {live.map((id) => (
          <LiveFigure key={id} sim={sim} id={id} look={lookOf.get(id) as Look} />
        ))}
      </Canvas>
      <div className="plaza-labels" ref={layer} aria-hidden="true">
        {people.map((p) => {
          const mode = p.id === sim.meId ? "me" : online.has(p.id) ? "online" : "wander";
          return (
            <div
              key={p.id}
              className={`plaza-tag-wrap ${mode}`}
              data-id={p.id}
              style={{ opacity: 0, visibility: "hidden" }}
              ref={(wrap) => {
                if (!wrap) {
                  tags.current.delete(p.id);
                  return;
                }
                const bubble = wrap.querySelector<HTMLDivElement>(".plaza-bubble");
                const tag = wrap.querySelector<HTMLDivElement>(".plaza-tag");
                if (bubble && tag && !tags.current.has(p.id)) {
                  tags.current.set(p.id, { wrap, bubble, tag, width: 0, height: 0, shownBubble: null, opacity: -1 });
                }
              }}
            >
              <div className="plaza-bubble" />
              <div className={`plaza-tag ${mode}`} title={p.name}>
                {mode === "me" ? (p.name ? `${p.name} (you)` : "You") : p.name}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
