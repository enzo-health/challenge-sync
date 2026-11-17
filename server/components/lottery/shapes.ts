// Shared geometries, built once per page and reused by every character, star and confetti piece.
import * as THREE from "three";

let star: THREE.BufferGeometry | null = null;

/** A chunky, puffy five-point star about 1 unit across, facing +z. */
export function starGeometry(): THREE.BufferGeometry {
  if (star) return star;
  const shape = new THREE.Shape();
  const points = 5;
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? 0.5 : 0.23;
    const a = (i / (points * 2)) * Math.PI * 2;
    const x = Math.sin(a) * r;
    const y = Math.cos(a) * r;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  star = new THREE.ExtrudeGeometry(shape, {
    depth: 0.12,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.05,
    bevelSegments: 3,
  });
  star.center();
  return star;
}

export interface CharacterGeometries {
  body: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  limb: THREE.BufferGeometry;
  foot: THREE.BufferGeometry;
  eye: THREE.BufferGeometry;
  ear: THREE.BufferGeometry;
  pointyEar: THREE.BufferGeometry;
  cone: THREE.BufferGeometry;
  dome: THREE.BufferGeometry;
  brim: THREE.BufferGeometry;
  stalk: THREE.BufferGeometry;
  ball: THREE.BufferGeometry;
  ring: THREE.BufferGeometry;
  crownBand: THREE.BufferGeometry;
  smile: THREE.BufferGeometry;
  frown: THREE.BufferGeometry;
}

let character: CharacterGeometries | null = null;

export function characterGeometries(): CharacterGeometries {
  if (character) return character;
  character = {
    body: new THREE.CapsuleGeometry(0.3, 0.32, 8, 20),
    head: new THREE.SphereGeometry(0.36, 28, 20),
    limb: new THREE.CapsuleGeometry(0.075, 0.2, 4, 10),
    foot: new THREE.SphereGeometry(0.12, 16, 10),
    eye: new THREE.SphereGeometry(0.055, 12, 10),
    ear: new THREE.SphereGeometry(0.1, 14, 10),
    pointyEar: new THREE.ConeGeometry(0.09, 0.22, 12),
    cone: new THREE.ConeGeometry(0.2, 0.42, 20),
    dome: new THREE.SphereGeometry(0.37, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    brim: new THREE.CylinderGeometry(0.4, 0.4, 0.05, 24),
    stalk: new THREE.CylinderGeometry(0.02, 0.02, 0.28, 6),
    ball: new THREE.SphereGeometry(0.075, 12, 10),
    ring: new THREE.TorusGeometry(0.55, 0.06, 12, 40),
    crownBand: new THREE.CylinderGeometry(0.24, 0.27, 0.16, 6, 1, true),
    smile: new THREE.TorusGeometry(0.09, 0.022, 8, 16, Math.PI),
    frown: new THREE.TorusGeometry(0.07, 0.02, 8, 16, Math.PI),
  };
  return character;
}
