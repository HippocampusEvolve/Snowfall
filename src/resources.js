import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ITEMS } from './data/items.js';
import { createGameProp, disposeModel } from './props/lab/tools.js';

export const STOCK_KINDS = ['stone', 'soil', 'snow', 'ore', 'block', 'timber', 'torch'];
const COLORS = { stone: 0x686c70, soil: 0x63513e, snow: 0xb6c4d0, ore: 0x78674e, block: 0x777975, timber: 0x78543a };
export const resourceName = kind => ITEMS.find(i => i.id === kind)?.name || kind;

// South of the workbench, with an aisle between the mineral bins and long rack.
export const RESOURCE_LAYOUT = Object.freeze({
  stone: { x: -2.1, z: -21.8, columns: 3, rows: 3 },
  soil: { x: -0.9, z: -21.8, columns: 3, rows: 3 },
  snow: { x: 0.3, z: -21.8, columns: 3, rows: 3 },
  ore: { x: 1.5, z: -21.8, columns: 3, rows: 3 },
  block: { x: 2.9, z: -21.8, columns: 2, rows: 2 },
  timber: { x: -1.2, z: -24.1, columns: 1, rows: 4 },
  torch: { x: 1.25, z: -24.1, columns: 1, rows: 4 },
});

// Reuse the laboratory torch, bake wood/cloth colors into one shared mesh.
// Unlit stock needs neither flame shaders nor a light per item.
function stockTorchGeometry() {
  const prop = createGameProp('torch');
  if (prop.userData.flame) prop.userData.flame.visible = false;
  prop.updateMatrixWorld(true);
  const parts = [];
  prop.traverseVisible(object => {
    if (!object.isMesh) return;
    const geometry = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry.clone();
    geometry.applyMatrix4(object.matrixWorld);
    for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal'].includes(name)) geometry.deleteAttribute(name);
    const color = object.material.color ?? new THREE.Color(0x826e50);
    const colors = new Float32Array(geometry.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    parts.push(geometry);
  });
  const geometry = mergeGeometries(parts);
  parts.forEach(part => part.dispose());
  disposeModel(prop);
  geometry.center();
  return geometry;
}

const overlapsFootprint = (a, b) => a.min.x < b.max.x - 1e-6 && a.max.x > b.min.x + 1e-6
  && a.min.z < b.max.z - 1e-6 && a.max.z > b.min.z + 1e-6;

// The ledger describes visible stock. One item can leave a pile in the hands;
// loose mined pieces have their own records and do not count as stored stock.
export class ResourceYard {
  constructor(scene, groundAt) {
    this.groundAt = groundAt;
    this.group = new THREE.Group();
    this.group.name = 'ResourceYard';
    scene.add(this.group);
    this.loose = [];
    this.slots = [];
    this.obstacles = [];
    this._shown = '';
    this.footprint = { x: 0.4, z: -22.9, hx: 4, hz: 2.2, rotY: 0 };
    this.materials = Object.fromEntries(Object.entries(COLORS).map(([kind, color]) => [kind,
      new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true })]));
    this.materials.torch = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.94 });
    this.geometries = {
      stone: new THREE.IcosahedronGeometry(0.14, 0), soil: new THREE.IcosahedronGeometry(0.13, 0),
      snow: new THREE.IcosahedronGeometry(0.14, 1), ore: new THREE.IcosahedronGeometry(0.13, 0),
      block: new THREE.BoxGeometry(0.6, 0.3, 0.3), timber: new THREE.CylinderGeometry(0.14, 0.14, 2.4, 10),
      torch: stockTorchGeometry(),
    };
    const wood = new THREE.MeshStandardMaterial({ color: 0x634d38, roughness: 1 });
    for (const kind of STOCK_KINDS) {
      const at = RESOURCE_LAYOUT[kind];
      const holder = new THREE.Group();
      holder.name = 'stock/' + kind;
      this.group.add(holder);
      const sample = this.mesh(kind);
      this.restRotation(sample, kind);
      sample.updateMatrixWorld(true);
      const pieceBounds = new THREE.Box3().setFromObject(sample);
      const size = pieceBounds.getSize(new THREE.Vector3());
      const stepX = size.x + 0.025, stepZ = size.z + 0.025;
      const width = (at.columns - 1) * stepX + size.x + 0.12;
      const depth = (at.rows - 1) * stepZ + size.z + 0.12;
      // Highest ground under the footprint keeps long timber out of a slope.
      const ground = Math.max(...[-1, 0, 1].flatMap(sx => [-1, 0, 1].map(sz =>
        groundAt(at.x + sx * width / 2, at.z + sz * depth / 2))));
      holder.position.set(at.x, ground, at.z);
      const supportTop = 0.09;
      for (const dx of [-width / 2 + 0.06, width / 2 - 0.06]) {
        for (const dz of [-depth / 2 + 0.06, depth / 2 - 0.06]) {
          const bottom = groundAt(at.x + dx, at.z + dz) - ground;
          const height = supportTop - bottom;
          const foot = new THREE.Mesh(new THREE.BoxGeometry(0.09, height, 0.09), wood);
          foot.position.set(dx, (bottom + supportTop) / 2, dz);
          holder.add(foot);
        }
      }
      // The deck supports every item instead of leaving rows over empty air.
      const deck = new THREE.Mesh(new THREE.BoxGeometry(width, 0.025, depth), wood);
      deck.position.y = supportTop - 0.0125;
      holder.add(deck);
      const meshes = [];
      const capacity = ITEMS.find(item => item.id === kind).stack;
      for (let n = 0; n < capacity; n++) {
        const mesh = this.mesh(kind);
        this.restRotation(mesh, kind);
        const layer = Math.floor(n / (at.columns * at.rows));
        mesh.position.set(
          (n % at.columns - (at.columns - 1) / 2) * stepX,
          supportTop - pieceBounds.min.y + layer * size.y,
          (Math.floor(n / at.columns) % at.rows - (at.rows - 1) / 2) * stepZ,
        );
        mesh.visible = false;
        holder.add(mesh);
        meshes.push(mesh);
      }
      const position = new THREE.Vector3(at.x, ground + supportTop + Math.min(0.4, size.y), at.z);
      this.slots.push({ kind, holder, meshes, position, width, depth });
      this.obstacles.push({ x1: at.x - width / 2 + 0.12, z1: at.z, x2: at.x + width / 2 - 0.12, z2: at.z, r: depth / 2 });
    }
    this.carried = new THREE.Group();
    this.carried.position.set(0.3, -0.32, -0.92);
    this.carriedMeshes = {};
    for (const kind of STOCK_KINDS.filter(kind => kind !== 'torch')) {
      const mesh = this.mesh(kind);
      mesh.visible = false;
      if (kind === 'timber') mesh.rotation.set(0, 0.35, Math.PI / 2 - 0.18);
      this.carried.add(mesh);
      this.carriedMeshes[kind] = mesh;
    }
    this.group.updateMatrixWorld(true);
  }

  mesh(kind) {
    const mesh = new THREE.Mesh(this.geometries[kind], this.materials[kind]);
    // Stock visibility belongs to the ledger, including during scene warm-up.
    mesh.userData.visibilityManaged = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  restRotation(mesh, kind, yaw = 0) {
    mesh.rotation.set(0, yaw, kind === 'timber' || kind === 'torch' ? Math.PI / 2 : 0);
  }

  update(inventory, carryKind, torchHeld) {
    const counts = STOCK_KINDS.map(kind => Math.max(0, inventory.count(kind)
      - (carryKind === kind || (kind === 'torch' && torchHeld) ? 1 : 0)));
    const key = counts.join(',');
    if (key !== this._shown) {
      this._shown = key;
      this.slots.forEach((slot, i) => slot.meshes.forEach((mesh, n) => { mesh.visible = n < counts[i]; }));
    }
    for (const [kind, mesh] of Object.entries(this.carriedMeshes)) mesh.visible = kind === carryKind;
  }

  drop(kind, position, yaw = 0) {
    if (!STOCK_KINDS.includes(kind) || !position || ![position.x, position.y, position.z, yaw].every(Number.isFinite)) return null;
    const mesh = this.mesh(kind);
    this.restRotation(mesh, kind, yaw);
    mesh.position.copy(position);
    mesh.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(mesh);
    const lift = position.y - bounds.min.y;
    mesh.position.y += lift;
    bounds.translate(new THREE.Vector3(0, lift, 0));
    // Crossing beams can touch far from their centres. Use geometry footprints.
    for (const entry of this.loose) {
      const support = new THREE.Box3().setFromObject(entry.mesh);
      if (!overlapsFootprint(bounds, support) || support.max.y <= bounds.min.y) continue;
      const rise = support.max.y - bounds.min.y;
      mesh.position.y += rise;
      bounds.translate(new THREE.Vector3(0, rise, 0));
    }
    const entry = { kind, position: mesh.position.clone(), yaw, mesh };
    this.loose.push(entry);
    this.group.add(mesh);
    return entry;
  }

  take(entry) {
    const i = this.loose.indexOf(entry);
    if (i < 0) return false;
    this.loose.splice(i, 1);
    this.group.remove(entry.mesh);
    return true;
  }

  target(camera, inventory, carrying = null) {
    const direction = new THREE.Vector3();
    camera.getWorldDirection(direction);
    let best = null, score = 0.82;
    const consider = (kind, ref, point, stock) => {
      const offset = point.clone().sub(camera.position), distance = offset.length();
      if (distance > 2.5 || distance < 0.02) return;
      const dot = offset.multiplyScalar(1 / distance).dot(direction);
      if (dot > score) { score = dot; best = { kind: stock ? 'stock' : 'resource', item: kind, ref, position: point }; }
    };
    for (const slot of this.slots) {
      if (carrying === slot.kind || (!carrying && inventory.count(slot.kind) > 0)) consider(slot.kind, slot, slot.position, true);
    }
    if (!carrying) for (const entry of this.loose) consider(entry.kind, entry, entry.position, false);
    return best;
  }

  serialize() {
    return this.loose.map(entry => ({ kind: entry.kind, x: entry.position.x, y: entry.position.y, z: entry.position.z, yaw: entry.yaw }));
  }

  restore(records = []) {
    for (const entry of [...this.loose]) this.take(entry);
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (!record || !STOCK_KINDS.includes(record.kind)
        || ![record.x, record.y, record.z, record.yaw].every(Number.isFinite)
        || Math.abs(record.x) >= 210 || Math.abs(record.z) >= 210 || record.y <= -60 || record.y >= 200) continue;
      const mesh = this.mesh(record.kind);
      mesh.position.set(record.x, record.y, record.z);
      this.restRotation(mesh, record.kind, record.yaw);
      const entry = { kind: record.kind, position: mesh.position.clone(), yaw: record.yaw, mesh };
      this.loose.push(entry);
      this.group.add(mesh);
    }
  }
}

