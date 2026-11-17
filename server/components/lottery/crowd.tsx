// The audience: members who didn't post this week, on the floor in front of the stage, facing it.
// Deliberately secondary: smaller, simpler (a body and a head, no faces since we see their backs),
// muted colours, and drawn as two instanced meshes so 40+ of them cost two draw calls.
// They bob in anticipation while the wheel spins and slump when the winner is announced.
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { hop } from "./avatar";
import { lookFor, muted } from "./look";
import { characterGeometries } from "./shapes";
import type { Spot } from "./layout";
import type { Show, StagePerson } from "./types";

export function Crowd({
  people,
  spots,
  scale,
  show,
  onHover,
}: {
  people: StagePerson[];
  spots: Spot[];
  scale: number;
  show: RefObject<Show>;
  onHover: (person: StagePerson | null) => void;
}) {
  const g = characterGeometries();
  const bodies = useRef<THREE.InstancedMesh>(null);
  const heads = useRef<THREE.InstancedMesh>(null);
  const looks = useMemo(() => people.map((p) => lookFor(p.memberId)), [people]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.7 }), []);
  useEffect(() => () => material.dispose(), [material]);
  const slump = useRef(0);
  // Each person's current lift, smoothed so the bobs settle instead of snapping when the wheel stops.
  const lifts = useRef<Float32Array>(new Float32Array(0));
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useLayoutEffect(() => {
    const color = new THREE.Color();
    looks.forEach((look, i) => {
      bodies.current?.setColorAt(i, color.set(muted(look.body)));
      heads.current?.setColorAt(i, color.set(muted(look.head, 0.3)));
    });
    if (bodies.current?.instanceColor) bodies.current.instanceColor.needsUpdate = true;
    if (heads.current?.instanceColor) heads.current.instanceColor.needsUpdate = true;
  }, [looks]);

  useFrame((state, dt) => {
    const sh = show.current;
    const t = state.clock.elapsedTime;
    const target = sh.phase === "won" ? 1 : 0;
    slump.current = sh.reducedMotion ? target : slump.current + (target - slump.current) * (1 - Math.exp(-4 * dt));
    const sl = slump.current;
    if (lifts.current.length !== people.length) lifts.current = new Float32Array(people.length);
    for (let i = 0; i < people.length; i++) {
      const spot = spots[i];
      const look = looks[i];
      if (!spot) continue;
      let lift = 0;
      let stretch = 1;
      if (!sh.reducedMotion) {
        if (sh.phase === "spinning") {
          // Anticipation bobs, quicker as the wheel slows: the phase is the stage's integrated beat
          // (see Show.hopBeat), never t % period, whose rate jumps as the period changes.
          const beat = (((sh.crowdBeat + look.phase / (Math.PI * 2)) % 1) + 1) % 1;
          const k = hop(beat);
          lift = k.lift * 0.12 * (0.4 + sh.progress);
          stretch = k.stretch;
        } else if (sh.phase === "ready") {
          stretch = 1 + 0.03 * Math.sin(t * 1.8 + look.phase);
        }
      }
      lifts.current[i] = sh.reducedMotion ? lift : lifts.current[i] + (lift - lifts.current[i]) * (1 - Math.exp(-14 * dt));
      lift = lifts.current[i];
      stretch *= 1 - 0.12 * sl;
      const h = look.height * stretch;
      const sc = scale;
      const bodyY = spot.y + lift + (0.1 + 0.46 * h) * sc;
      dummy.position.set(spot.x, bodyY, spot.z);
      dummy.rotation.set(0.25 * sl, Math.PI, 0); // shoulders hunch toward the stage
      dummy.scale.set(look.girth * sc, h * sc, look.girth * sc);
      dummy.updateMatrix();
      bodies.current?.setMatrixAt(i, dummy.matrix);

      const neck = spot.y + lift + (0.1 + 0.92 * h - 0.06) * sc;
      // Slumped: the head drops and tips forward (toward the stage, i.e. -z).
      dummy.position.set(spot.x, neck + (0.3 - 0.14 * sl) * look.headSize * sc, spot.z - 0.14 * sl * sc);
      dummy.rotation.set(0, Math.PI, 0);
      dummy.scale.setScalar(look.headSize * sc);
      dummy.updateMatrix();
      heads.current?.setMatrixAt(i, dummy.matrix);
    }
    if (bodies.current) bodies.current.instanceMatrix.needsUpdate = true;
    if (heads.current) heads.current.instanceMatrix.needsUpdate = true;
  });

  if (people.length === 0) return null;

  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId != null) onHover(people[e.instanceId] ?? null);
  };

  return (
    <group>
      <instancedMesh
        ref={bodies}
        args={[g.body, material, people.length]}
        castShadow
        onPointerMove={hover}
        onPointerOut={() => onHover(null)}
      />
      <instancedMesh
        ref={heads}
        args={[g.head, material, people.length]}
        castShadow
        onPointerMove={hover}
        onPointerOut={() => onHover(null)}
      />
    </group>
  );
}
