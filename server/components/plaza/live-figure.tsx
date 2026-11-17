// The full character (../lottery/avatar.tsx's Character, hat, face and all) for you and for each
// member who is online, posed every frame from the sim: walking, jumping, high-fiving. A ring on
// the ground marks them out from the wanderers: pink for you, teal for everyone online.
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { Character, useCharacterMaterials, useCharacterRig } from "../lottery/avatar";
import type { Look } from "../lottery/look";
import { JUMP_SECONDS, type PlazaSim } from "./sim";

const damp = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));

const ringGeometry = new THREE.RingGeometry(0.42, 0.55, 40).rotateX(-Math.PI / 2);
const ringMaterials = {
  me: new THREE.MeshBasicMaterial({ color: "#ff4d6d", transparent: true, opacity: 0.85, depthWrite: false }),
  online: new THREE.MeshBasicMaterial({ color: "#1fb5a6", transparent: true, opacity: 0.85, depthWrite: false }),
};

export function LiveFigure({ sim, id, look }: { sim: PlazaSim; id: number; look: Look }) {
  const mats = useCharacterMaterials(look);
  const rig = useCharacterRig();
  const place = useRef<THREE.Group>(null);
  const pose = useRef({ armUp: 0.25, armFwd: 0 });
  const isMe = id === sim.meId;

  useFrame((_, dt) => {
    const p = sim.byId.get(id);
    const g = place.current;
    if (!p || !g) return;
    g.position.set(p.x, 0, p.z);
    const m = rig.mover.current;
    if (m) {
      m.position.y = p.lift;
      const wide = 1 / Math.sqrt(p.stretch);
      m.scale.set(wide, p.stretch, wide);
      m.rotation.set(0, p.yaw, 0);
    }
    const t = sim.t;
    let armUp = 0.25;
    let armFwd = 0;
    let swing = 0;
    const jumping = t - p.jumpAt >= 0 && t - p.jumpAt < JUMP_SECONDS;
    if (sim.fiving(p)) {
      // Both hands up and toward their partner.
      armUp = 2.75;
      armFwd = -0.55;
    } else if (jumping) {
      armUp = 1.9;
    } else if (p.speed > 0.2 && !sim.reducedMotion) {
      swing = Math.sin(p.walk * Math.PI * 2) * 0.55 * Math.min(1, p.speed / 2.5);
    }
    const P = pose.current;
    P.armUp = damp(P.armUp, armUp, 14, dt);
    P.armFwd = damp(P.armFwd, armFwd, 14, dt);
    rig.armL.current?.rotation.set(P.armFwd + swing, 0, P.armUp);
    rig.armR.current?.rotation.set(P.armFwd - swing, 0, -P.armUp);
  });

  return (
    <group ref={place}>
      <mesh geometry={ringGeometry} material={isMe ? ringMaterials.me : ringMaterials.online} position={[0, 0.02, 0]} renderOrder={1} />
      <Character look={look} rig={rig} mats={mats} />
    </group>
  );
}
