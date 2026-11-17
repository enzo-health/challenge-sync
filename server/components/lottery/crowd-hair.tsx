// Saved hair on the crowd. We see the audience from behind, so hair is the custom feature that
// shows most there. One instanced mesh per hair style actually in use (the style's merged geometry
// from shapes.ts), so 40-80 people stay a handful of draw calls; colours are muted like the rest
// of the crowd. crowd.tsx owns the head maths and hands each head's matrix over every frame
// through the handle (`place`, then `commit`), so nothing here allocates per frame.
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import type { Hair } from "./avatar-model";
import { type Look, muted } from "./look";
import { hairGeometry } from "./shapes";

export interface CrowdHairHandle {
  /** Person `i`'s head transform this frame (the instanced head's matrix: head space, scaled). */
  place(i: number, head: THREE.Matrix4): void;
  /** After every `place` of a frame. */
  commit(): void;
}

interface Group {
  style: Hair;
  geometry: THREE.BufferGeometry;
  people: number[];
}

export const CrowdHair = forwardRef<CrowdHairHandle, { looks: Look[] }>(function CrowdHair({ looks }, ref) {
  // Which style each person wears, and their slot in that style's instanced mesh.
  const { groups, slotOf } = useMemo(() => {
    const byStyle = new Map<Hair, Group>();
    const slotOf: { group: number; slot: number }[] = [];
    looks.forEach((look, i) => {
      const geometry = hairGeometry(look.hair);
      if (!geometry) {
        slotOf.push({ group: -1, slot: -1 });
        return;
      }
      let group = byStyle.get(look.hair);
      if (!group) {
        group = { style: look.hair, geometry, people: [] };
        byStyle.set(look.hair, group);
      }
      group.people.push(i);
      slotOf.push({ group: [...byStyle.keys()].indexOf(look.hair), slot: group.people.length - 1 });
    });
    return { groups: [...byStyle.values()], slotOf };
  }, [looks]);

  const meshes = useRef<(THREE.InstancedMesh | null)[]>([]);
  const material = useMemo(() => new THREE.MeshStandardMaterial({ roughness: 0.75, side: THREE.DoubleSide }), []);
  useEffect(() => () => material.dispose(), [material]);

  useLayoutEffect(() => {
    const color = new THREE.Color();
    groups.forEach((group, g) => {
      const mesh = meshes.current[g];
      if (!mesh) return;
      group.people.forEach((person, slot) => mesh.setColorAt(slot, color.set(muted(looks[person].hairColor))));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
  }, [groups, looks]);

  useImperativeHandle(
    ref,
    () => ({
      place(i, head) {
        const at = slotOf[i];
        if (!at || at.group < 0) return;
        meshes.current[at.group]?.setMatrixAt(at.slot, head);
      },
      commit() {
        for (const mesh of meshes.current) if (mesh) mesh.instanceMatrix.needsUpdate = true;
      },
    }),
    [slotOf],
  );

  return (
    <>
      {groups.map((group, g) => (
        <instancedMesh
          key={`${group.style}:${group.people.length}`}
          ref={(mesh) => {
            meshes.current[g] = mesh;
          }}
          args={[group.geometry, material, group.people.length]}
          // The instances move every frame; the bounds computed from their first positions would go stale.
          frustumCulled={false}
          castShadow
        />
      ))}
    </>
  );
});
