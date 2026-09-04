import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { TORCH_PARTS } from './torch-geometry.js';
import { selectLitTorches } from './torch-lights.js';
import { quantizePlacement } from './placements.js';

export { countTorchTriangles } from './torch-geometry.js';
export { selectLitTorches } from './torch-lights.js';

// Два слота остаются факелам, два постоянных - костру и очагу избы.
export const TORCH_LIGHT_SLOTS = 2;

const REST = new THREE.Euler(-0.1, 0.08, 0.08);
const PIVOT_Y = 0.34;
const TIP = new THREE.Vector3(0.34, -0.24, -0.58 * VIEW_Z);

const FLAME_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FLAME_FRAGMENT = `
  uniform float uTime;
  varying vec2 vUv;
  void main() {
    float sway = sin(uTime * 5.7 + vUv.y * 5.0) * 0.055 * vUv.y;
    float ragged = sin(vUv.y * 31.0 + uTime * 11.0) * 0.025;
    float width = (1.0 - vUv.y) * 0.42 + 0.045 + ragged;
    float body = 1.0 - smoothstep(width, width + 0.075, abs(vUv.x - 0.5 - sway));
    float foot = smoothstep(0.0, 0.12, vUv.y);
    float tip = 1.0 - smoothstep(0.78, 1.0, vUv.y);
    float alpha = body * foot * tip;
    vec3 edge = vec3(1.0, 0.25, 0.015);
    vec3 core = vec3(1.0, 0.86, 0.35);
    float hot = (1.0 - smoothstep(0.0, width, abs(vUv.x - 0.5 - sway)))
      * (1.0 - vUv.y);
    gl_FragColor = vec4(mix(edge, core, hot), alpha);
  }
`;

function flameMaterial(register) {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: FLAME_VERTEX,
    fragmentShader: FLAME_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  register.add(material);
  return material;
}

function buildTorch(register) {
  const group = new THREE.Group();
  const mats = {
    wood: new THREE.MeshStandardMaterial({ color: 0x5d3822, roughness: 0.92, flatShading: true }),
    wrap: new THREE.MeshStandardMaterial({ color: 0x26150f, roughness: 1, flatShading: true }),
    ember: new THREE.MeshStandardMaterial({
      color: 0x361207, emissive: 0xff5a16, emissiveIntensity: 2.2, roughness: 1,
    }),
  };
  for (const part of TORCH_PARTS) {
    let geometry;
    let mat;
    if (part.kind === 'cylinder') {
      geometry = new THREE.CylinderGeometry(
        part.radiusTop, part.radiusBottom, part.h, part.segments, 1
      );
      mat = mats[part.role];
    } else if (part.kind === 'icosahedron') {
      geometry = new THREE.IcosahedronGeometry(part.radius, part.detail);
      mat = mats[part.role];
    } else {
      geometry = new THREE.PlaneGeometry(part.w, part.h);
      mat = flameMaterial(register);
    }
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.position.y = part.y;
    mesh.rotation.y = part.ry || 0;
    mesh.castShadow = part.role !== 'flame';
    mesh.renderOrder = part.role === 'flame' ? 3 : 0;
    group.add(mesh);
  }
  return group;
}

export class Torch extends HeldTool {
  constructor(scene, view) {
    const flameMaterials = new Set();
    const build = () => buildTorch(flameMaterials);
    super(scene, view, {
      build,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: {},
      plantPose(world, x, y, z) {
        world.position.set(x, y, z);
      },
    });
    this.scene = scene;
    this._build = build;
    this._flameMaterials = flameMaterials;
    this.placed = [];
    this.heldLight = new THREE.PointLight(0xff9a43, 0, 9, 2);
    scene.add(this.heldLight);
  }

  _addPlaced(position, id = 0) {
    const model = this._build();
    model.position.copy(position);
    this.scene.add(model);
    const light = new THREE.PointLight(0xff9440, 0, 9, 2);
    light.position.set(position.x, position.y + 0.92, position.z);
    this.scene.add(light);
    const entry = { id, position: position.clone(), model, light };
    this.placed.push(entry);
    return entry;
  }

  _removePlaced(entry) {
    const index = this.placed.indexOf(entry);
    if (index < 0) return false;
    this.placed.splice(index, 1);
    this.scene.remove(entry.model, entry.light);
    entry.model.traverse((object) => {
      if (object.geometry) object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const mat of materials) {
        if (!mat) continue;
        this._flameMaterials.delete(mat);
        mat.dispose();
      }
    });
    return true;
  }

  plantAt(position, inventory, notePlace) {
    if (!this.held || inventory.take('torch', 1) !== 1) return null;
    const q = quantizePlacement(position);
    const id = notePlace(q, false);
    const entry = this._addPlaced(new THREE.Vector3(q.x, q.y, q.z), id);
    this.held = false;
    this.holder.visible = false;
    this._rest();
    return entry;
  }

  takePlaced(entry, inventory, notePlace) {
    if (inventory.add('torch', 1) !== 1) return false;
    notePlace(entry.position, true);
    this._removePlaced(entry);
    this.take();
    return true;
  }

  restore(records) {
    for (const entry of [...this.placed]) this._removePlaced(entry);
    for (const record of records) {
      this._addPlaced(new THREE.Vector3(record.x, record.y, record.z), record.seq);
    }
  }

  update(dt, t, camera, lightSlots = TORCH_LIGHT_SLOTS) {
    super.update(dt, () => false);
    for (const material of this._flameMaterials) material.uniforms.uTime.value = t;
    const flicker = 0.88 + Math.sin(t * 9.7) * 0.08 + Math.sin(t * 23.1) * 0.04;
    this.heldLight.intensity = this.held ? 8.5 * flicker : 0;
    if (this.held) {
      camera.getWorldDirection(this.heldLight.position);
      this.heldLight.position.multiplyScalar(0.45).add(camera.position);
      this.heldLight.position.y -= 0.12;
    }
    const limit = Math.max(0, lightSlots - (this.held ? 1 : 0));
    const lit = new Set(selectLitTorches(this.placed, camera.position, limit));
    for (let i = 0; i < this.placed.length; i++) {
      const entry = this.placed[i];
      entry.light.intensity = lit.has(entry)
        ? 7.5 * (0.9 + Math.sin(t * 8.3 + i * 1.7) * 0.1)
        : 0;
    }
  }
}
