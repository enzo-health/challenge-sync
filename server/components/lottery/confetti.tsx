// Confetti and stars: two instanced meshes with simple physics (gravity, drag, flutter, spin).
// Fired in volleys when `burst` changes; pieces settle on the floor and stay until the next burst.
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { PARTY } from "./look";
import { starGeometry } from "./shapes";

const PAPER = 380;
const STARS = 70;

interface Particles {
  pos: Float32Array;
  vel: Float32Array;
  rot: Float32Array;
  spin: Float32Array;
  /** Seconds until launch; negative while flying; NaN when idle. */
  delay: Float32Array;
  settled: Uint8Array;
}

function makeParticles(n: number): Particles {
  return {
    pos: new Float32Array(n * 3),
    vel: new Float32Array(n * 3),
    rot: new Float32Array(n * 3),
    spin: new Float32Array(n * 3),
    delay: new Float32Array(n).fill(Number.NaN),
    settled: new Uint8Array(n),
  };
}

export interface Volley {
  origin: [number, number, number];
  /** Main launch direction (normalised in use). */
  direction: [number, number, number];
  speed: number;
  spread: number;
  delay: number;
}

function launch(p: Particles, count: number, volleys: Volley[]) {
  for (let i = 0; i < count; i++) {
    const v = volleys[i % volleys.length];
    const [dx, dy, dz] = v.direction;
    const len = Math.hypot(dx, dy, dz) || 1;
    const sp = v.speed * (0.6 + Math.random() * 0.6);
    p.pos.set([v.origin[0] + (Math.random() - 0.5) * 0.4, v.origin[1], v.origin[2] + (Math.random() - 0.5) * 0.4], i * 3);
    p.vel.set(
      [
        (dx / len + (Math.random() - 0.5) * v.spread) * sp,
        (dy / len + (Math.random() - 0.5) * v.spread * 0.6) * sp,
        (dz / len + (Math.random() - 0.5) * v.spread) * sp,
      ],
      i * 3,
    );
    p.rot.set([Math.random() * 6, Math.random() * 6, Math.random() * 6], i * 3);
    p.spin.set([(Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14, (Math.random() - 0.5) * 14], i * 3);
    p.delay[i] = v.delay + Math.random() * 0.25;
    p.settled[i] = 0;
  }
}

function step(p: Particles, count: number, dt: number, t: number, floorAt: (x: number, z: number) => number, flutter: number) {
  for (let i = 0; i < count; i++) {
    const d = p.delay[i];
    if (Number.isNaN(d)) continue;
    if (d > 0) {
      p.delay[i] = d - dt;
      continue;
    }
    if (p.settled[i]) continue;
    const o = i * 3;
    const drag = Math.exp(-1.6 * dt);
    p.vel[o] = p.vel[o] * drag + Math.sin(t * 5 + i) * flutter * dt;
    p.vel[o + 1] = Math.max(p.vel[o + 1] * drag - 9 * dt, -2.2); // paper reaches a gentle terminal speed
    p.vel[o + 2] = p.vel[o + 2] * drag + Math.cos(t * 4 + i * 1.3) * flutter * dt;
    p.pos[o] += p.vel[o] * dt;
    p.pos[o + 1] += p.vel[o + 1] * dt;
    p.pos[o + 2] += p.vel[o + 2] * dt;
    p.rot[o] += p.spin[o] * dt;
    p.rot[o + 1] += p.spin[o + 1] * dt;
    p.rot[o + 2] += p.spin[o + 2] * dt;
    const floor = floorAt(p.pos[o], p.pos[o + 2]) + 0.01;
    if (p.pos[o + 1] < floor && p.vel[o + 1] < 0) {
      p.pos[o + 1] = floor;
      p.rot[o] = -Math.PI / 2; // lie flat
      p.rot[o + 1] = 0;
      p.settled[i] = 1;
    }
  }
}

export function Confetti({
  burst,
  volleys,
  floorAt,
}: {
  burst: number;
  volleys: Volley[];
  /** The height pieces come to rest at. */
  floorAt: (x: number, z: number) => number;
}) {
  const paperRef = useRef<THREE.InstancedMesh>(null);
  const starRef = useRef<THREE.InstancedMesh>(null);
  const paper = useMemo(() => makeParticles(PAPER), []);
  const stars = useMemo(() => makeParticles(STARS), []);
  const geo = useMemo(() => new THREE.PlaneGeometry(0.09, 0.16), []);
  const paperMat = useMemo(() => new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.6 }), []);
  const starMat = useMemo(
    () => new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.2, emissive: "#ffb703", emissiveIntensity: 0.35 }),
    [],
  );
  useEffect(
    () => () => {
      geo.dispose();
      paperMat.dispose();
      starMat.dispose();
    },
    [geo, paperMat, starMat],
  );
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const c = new THREE.Color();
    for (let i = 0; i < PAPER; i++) paperRef.current?.setColorAt(i, c.set(PARTY[i % PARTY.length]));
    const starColors = ["#ffc93c", "#ffe066", "#ffffff", "#ff70a6", "#4cc9f0"];
    for (let i = 0; i < STARS; i++) starRef.current?.setColorAt(i, c.set(starColors[i % starColors.length]));
    if (paperRef.current?.instanceColor) paperRef.current.instanceColor.needsUpdate = true;
    if (starRef.current?.instanceColor) starRef.current.instanceColor.needsUpdate = true;
  }, []);

  useEffect(() => {
    if (burst === 0) {
      paper.delay.fill(Number.NaN);
      stars.delay.fill(Number.NaN);
      return;
    }
    launch(paper, PAPER, volleys);
    launch(stars, STARS, volleys);
  }, [burst, volleys, paper, stars]);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 1 / 20);
    const t = state.clock.elapsedTime;
    step(paper, PAPER, dt, t, floorAt, 3);
    step(stars, STARS, dt, t, floorAt, 1);
    const write = (mesh: THREE.InstancedMesh | null, p: Particles, count: number, size: number) => {
      if (!mesh) return;
      for (let i = 0; i < count; i++) {
        const o = i * 3;
        const waiting = Number.isNaN(p.delay[i]) || p.delay[i] > 0;
        dummy.position.set(p.pos[o], p.pos[o + 1], p.pos[o + 2]);
        dummy.rotation.set(p.rot[o], p.rot[o + 1], p.rot[o + 2]);
        dummy.scale.setScalar(waiting ? 0 : size);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    };
    write(paperRef.current, paper, PAPER, 1);
    write(starRef.current, stars, STARS, 0.2);
  });

  return (
    <>
      <instancedMesh ref={paperRef} args={[geo, paperMat, PAPER]} frustumCulled={false} />
      <instancedMesh ref={starRef} args={[starGeometry(), starMat, STARS]} frustumCulled={false} castShadow />
    </>
  );
}
