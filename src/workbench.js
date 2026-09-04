import * as THREE from 'three';
import { material } from 'world-core/materials';
import { matset } from './matsets.js';
import { WORKBENCH_PARTS } from './workbench-geometry.js';

export { countWorkbenchTriangles } from './workbench-geometry.js';

export const WORKBENCH_AT = Object.freeze({ x: -0.5, z: -19.2, yaw: 0.95 });

function buildWorkbench() {
  const group = new THREE.Group();
  group.name = 'Workbench';
  const mats = {
    floor: material(matset('floor'), { normalScale: 0.8, color: 0x9a7049 }),
    beam: material(matset('beam'), { normalScale: 0.8, color: 0x67452f }),
    metal: new THREE.MeshStandardMaterial({
      color: 0x4a4c4b, metalness: 0.28, roughness: 0.58, flatShading: true,
    }),
  };
  for (const part of WORKBENCH_PARTS) {
    const geometry = part.kind === 'box'
      ? new THREE.BoxGeometry(part.w, part.h, part.d)
      : new THREE.CylinderGeometry(part.radius, part.radius, part.h, part.segments, 1);
    const mesh = new THREE.Mesh(geometry, mats[part.role]);
    mesh.position.set(part.x, part.y, part.z);
    mesh.rotation.set(part.rx || 0, part.ry || 0, part.rz || 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

export class Workbench {
  constructor(terrain, at = WORKBENCH_AT) {
    const y = terrain.getHeight(at.x, at.z);
    this.group = buildWorkbench();
    this.group.position.set(at.x, y, at.z);
    this.group.rotation.y = at.yaw;
    this.position = new THREE.Vector3(at.x, y + 0.86, at.z);
    this.obstacle = { x: at.x, z: at.z, r: 1.05 };
  }
}
