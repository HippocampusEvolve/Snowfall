import * as THREE from 'three';
import { createRandom } from './generators.js';

export const RABBIT_PLACEMENT = { x: -4.85, z: 2.8, scale: 0.85, yaw: -0.35 };
export const RABBIT_VIEW = { radius: 5.6, theta: 2.5, phi: 1.13, targetY: 0.94 };
const HEAD = new THREE.Vector3(0, 1.12, 0.46);
const clamp = THREE.MathUtils.clamp;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const blend = (a, b, k) => {
  const h = clamp(0.5 + (b - a) / (2 * k), 0, 1);
  return b * (1 - h) + a * h - k * h * (1 - h);
};

function makeField(seed) {
  const random = createRandom(seed);
  const roundness = 0.98 + random() * 0.04;
  const parts = [
    [0, 0.65, -0.05, 0.37, 0.47, 0.61], // back and belly
    [0, 0.66, -0.40, 0.45 * roundness, 0.48, 0.47],
    [0, 0.87, 0.32, 0.28, 0.38, 0.31], // high chest
    [0, 1.10, 0.43, 0.205, 0.27, 0.23],
    [0, 1.29, 0.65, 0.285, 0.26, 0.30], // skull
    [0, 1.17, 0.91, 0.205, 0.14, 0.235], // tapered muzzle
    [-0.15, 1.19, 0.81, 0.13, 0.14, 0.17],
    [0.15, 1.19, 0.81, 0.13, 0.14, 0.17],
    [0, 0.64, -0.90, 0.17, 0.185, 0.21], // attached tail
  ];
  for (const side of [-1, 1]) {
    parts.push([side * 0.32, 0.43, -0.38, 0.24, 0.35, 0.34]);
    parts.push([side * 0.34, 0.115, -0.14, 0.15, 0.12, 0.35]);
    parts.push([side * 0.18, 0.39, 0.38, 0.085, 0.31, 0.105]);
    parts.push([side * 0.18, 0.105, 0.54, 0.095, 0.10, 0.245]);
  }
  return (x, y, z) => {
    let distance = 10;
    for (let i = 0; i < parts.length; i++) {
      const [cx, cy, cz, rx, ry, rz] = parts[i];
      const ellipsoid = (Math.hypot((x - cx) / rx, (y - cy) / ry, (z - cz) / rz) - 1) * Math.min(rx, ry, rz);
      distance = blend(distance, ellipsoid, i < 9 ? 0.075 : 0.037);
    }
    return Math.max(distance, 0.022 - y);
  };
}

function gradient(field, p) {
  const e = 0.0003, { x, y, z } = p;
  return new THREE.Vector3(field(x + e, y, z) - field(x - e, y, z),
    field(x, y + e, z) - field(x, y - e, z), field(x, y, z + e) - field(x, y, z - e)).normalize();
}

function furColor(p, seed) {
  const brush = Math.sin(p.x * 9 + Math.sin(p.z * 7)) * Math.cos(p.y * 10 - p.z * 4);
  const broad = Math.sin(p.y * 4 + p.z * 3 + seed * 0.17) * 0.5 + 0.5;
  const shade = new THREE.Color(0x9c9e94).lerp(new THREE.Color(0xc3c0ac), 0.38 + broad * 0.35);
  const bib = smooth(0.1, 0.5, p.z) * (1 - smooth(0.18, 0.31, Math.abs(p.x))) * (1 - smooth(1.19, 1.4, p.y));
  const muzzle = smooth(0.84, 1.06, p.z);
  const feet = 1 - smooth(0.16, 0.32, p.y);
  const tail = 1 - smooth(-0.98, -0.8, p.z);
  shade.lerp(new THREE.Color(0xded5bb), Math.max(bib * 0.8, muzzle * 0.7, feet * 0.55, tail * 0.65));
  return shade.multiplyScalar(1 + brush * 0.045);
}

// Marching tetrahedra makes one watertight body: no intersecting sphere shells
// at the shoulder, cheek, haunch or paw. Continuous normals/paint hide the mesh.
function bodyGeometry(field, seed) {
  const positions = [], normals = [], colors = [], weights = [], indices = [];
  const minimum = [-0.7, -0.1, -1.25], maximum = [0.7, 1.7, 1.3];
  const resolution = [18, 24, 33];
  const step = maximum.map((v, i) => (v - minimum[i]) / resolution[i]);
  const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const tetrahedra = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
  const lattice = new Map();
  const sample = (i, j, k) => {
    const key = `${i},${j},${k}`;
    if (!lattice.has(key)) {
      const p = new THREE.Vector3(minimum[0] + i * step[0], minimum[1] + j * step[1], minimum[2] + k * step[2]);
      lattice.set(key, { p, d: field(p.x, p.y, p.z) });
    }
    return lattice.get(key);
  };
  const cross = (a, b) => a.p.clone().lerp(b.p, a.d / (a.d - b.d));
  const emit = (a, b, c) => {
    let face = b.clone().sub(a).cross(c.clone().sub(a));
    if (face.lengthSq() < 1e-18) return;
    const center = a.clone().add(b).add(c).multiplyScalar(1 / 3);
    if (face.dot(gradient(field, center)) < 0) { [b, c] = [c, b]; face.negate(); }
    face.normalize();
    for (const p of [a, b, c]) {
      positions.push(p.x, p.y, p.z);
      const normal = gradient(field, p);
      normals.push(normal.x, normal.y, normal.z);
      const paint = furColor(p, seed);
      colors.push(paint.r, paint.g, paint.b);
      const head = smooth(0.82, 1.16, p.y) * smooth(0.16, 0.49, p.z);
      const breath = (1 - head) * smooth(0.20, 0.50, p.y) * (1 - smooth(0.85, 1.2, p.y));
      const front = smooth(0.12, 0.32, p.z) * (1 - smooth(0.30, 0.61, p.y));
      const hind = (1 - smooth(0.02, 0.27, p.z)) * (1 - smooth(0.24, 0.62, p.y)) * smooth(0.09, 0.23, Math.abs(p.x));
      const leg = Math.max(front, hind) * 0.98;
      weights.push((1 - head - breath) * (1 - leg), breath * (1 - leg), head * (1 - leg), leg);
      indices.push(0, 1, 2, (front > hind ? 3 : 5) + (p.x > 0 ? 1 : 0));
    }
  };
  for (let i = 0; i < resolution[0]; i++) for (let j = 0; j < resolution[1]; j++) for (let k = 0; k < resolution[2]; k++) {
    const cell = corners.map(([x, y, z]) => sample(i + x, j + y, k + z));
    if (cell.every(s => s.d >= 0) || cell.every(s => s.d < 0)) continue;
    for (const tet of tetrahedra) {
      const inside = tet.map(t => cell[t]).filter(s => s.d < 0);
      const outside = tet.map(t => cell[t]).filter(s => s.d >= 0);
      if (inside.length === 1) emit(...outside.map(b => cross(inside[0], b)));
      if (inside.length === 3) emit(...inside.map(b => cross(outside[0], b)));
      if (inside.length === 2) {
        const p = inside.flatMap(a => outside.map(b => cross(a, b)));
        emit(p[0], p[1], p[2]); emit(p[1], p[3], p[2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('restPosition', g.attributes.position.clone());
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  return g;
}

function earGeometry(length) {
  const segments = 16;
  const rings = Array.from({ length: 15 }, (_, i) => {
    const h = i / 14;
    return [h, (0.048 + 0.087 * Math.pow(Math.sin(h * Math.PI), 0.9)) * (1 - 0.90 * smooth(0.78, 1, h))];
  });
  const p = [], triangles = [];
  for (const [h, w] of rings) for (let i = 0; i < segments; i++) {
    const angle = i * Math.PI * 2 / segments;
    const x = Math.cos(angle) * w;
    const z = Math.sin(angle) * (0.028 + Math.abs(Math.cos(angle)) * 0.020) - h * h * 0.065;
    p.push(x, h * length, z);
  }
  for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < segments; i++) {
    const a = j * segments + i, next = j * segments + (i + 1) % segments, b = a + segments;
    triangles.push(a, b, next, b, next + segments, next);
  }
  for (const end of [0, rings.length - 1]) {
    const h = rings[end][0], center = p.length / 3;
    p.push(0, h * length, -h * h * 0.065);
    for (let i = 0; i < segments; i++) {
      const a = end * segments + i, b = end * segments + (i + 1) % segments;
      triangles.push(...(end === 0 ? [center, a, b] : [center, b, a]));
    }
  }
  const indexed = new THREE.BufferGeometry();
  indexed.setAttribute('position', new THREE.Float32BufferAttribute(p, 3)); indexed.setIndex(triangles);
  indexed.computeVertexNormals();
  const g = indexed.toNonIndexed(); indexed.dispose();
  g.setAttribute('restPosition', g.attributes.position.clone());
  const colors = [];
  for (let i = 0; i < g.attributes.position.count; i++) {
    const center = new THREE.Vector3().fromBufferAttribute(g.attributes.position, i);
    const h = center.y / length;
    const inner = smooth(0.007, 0.027, center.z + h * h * 0.065) * smooth(0.10, 0.27, h);
    const tint = new THREE.Color(0xcac4af).lerp(new THREE.Color(0xa38b7e), inner);
    if (h > 0.83) tint.lerp(new THREE.Color(0x5e625b), smooth(0.83, 1, h) * 0.9);
    colors.push(tint.r, tint.g, tint.b);
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return g;
}

export function createRabbitBody(seed) {
  return bodyGeometry(makeField(seed), seed);
}

export function createRabbit(seed, materials, preparedBody) {
  const field = makeField(seed);
  const root = new THREE.Group(); root.name = 'Rabbit';
  const body = new THREE.SkinnedMesh(preparedBody ?? bodyGeometry(field, seed), materials.fur);
  body.name = 'rabbit/body'; body.castShadow = true; body.receiveShadow = true;
  const base = new THREE.Bone(); base.name = 'Ground';
  const breath = new THREE.Bone(); breath.name = 'Breath'; breath.position.y = 0.55;
  const head = new THREE.Bone(); head.name = 'Head'; head.position.copy(HEAD);
  base.add(breath, head); body.add(base); root.add(body);
  const legs = [[-0.18, 0.52, 0.38], [0.18, 0.52, 0.38], [-0.32, 0.43, -0.38], [0.32, 0.43, -0.38]].map((p, i) => {
    const leg = new THREE.Bone(); leg.name = `Leg${i}`; leg.position.fromArray(p); base.add(leg); return leg;
  });
  const skeleton = new THREE.Skeleton([base, breath, head, ...legs]); body.bind(skeleton);
  const add = (name, geometry, material, position) => {
    const m = new THREE.Mesh(geometry, material); m.name = `rabbit/${name}`;
    m.position.copy(new THREE.Vector3(...position).sub(HEAD));
    m.castShadow = true; m.receiveShadow = true; head.add(m); return m;
  };
  const ears = [-1, 1].map(side => {
    const ear = add(`ear${side}`, earGeometry(side < 0 ? 0.91 : 0.98), materials.fur, [side * 0.13, 1.45, 0.59]);
    ear.rotation.set(side < 0 ? -0.11 : 0.14, side * 0.08, -side * 0.18);
    ear.userData.restRotation = ear.rotation.clone(); return ear;
  });
  const eyes = [];
  for (const side of [-1, 1]) {
    const y = 1.32, z = 0.805;
    let low = 0, high = 0.5;
    for (let i = 0; i < 28; i++) { const x = (low + high) / 2; if (field(x, y, z) < 0) low = x; else high = x; }
    const p = new THREE.Vector3(side * high, y, z), normal = gradient(field, p);
    const g = new THREE.IcosahedronGeometry(1, 2); g.scale(0.052, 0.065, 0.032);
    const eye = add(`eye${side}`, g, materials.eye, p.clone().addScaledVector(normal, 0.005).toArray());
    eye.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    const glint = new THREE.Mesh(new THREE.IcosahedronGeometry(0.008, 1), materials.glint);
    glint.name = `rabbit/glint${side}`; glint.position.set(-0.010, 0.02, 0.028); eye.add(glint);
    eyes.push(eye);
  }
  let low = 0.9, high = 1.4;
  for (let i = 0; i < 28; i++) { const z = (low + high) / 2; if (field(0, 1.17, z) < 0) low = z; else high = z; }
  const noseGeometry = new THREE.ConeGeometry(0.052, 0.055, 3, 1);
  noseGeometry.rotateX(Math.PI / 2);
  const nose = add('nose', noseGeometry, materials.nose, [0, 1.17, high + 0.009]);
  const phase = createRandom(seed + 97)() * Math.PI * 2;
  const update = (seconds, reducedMotion = false, pose = {}) => {
    const t = reducedMotion ? 0 : seconds;
    const live = reducedMotion ? 0 : 1;
    const grazing = reducedMotion ? 0 : (pose.graze || 0);
    const scared = reducedMotion ? 0 : (pose.scared || 0);
    const crouch = reducedMotion ? 0 : (pose.crouch || 0);
    const flight = reducedMotion ? 0 : (pose.flight || 0);
    const moving = (pose.hopHeight || 0) > 0.001 && !reducedMotion;
    breath.scale.set(1 + Math.sin(t * 2.5) * 0.012 * live, 1 + Math.sin(t * 2.5) * 0.008 * live, 1);
    breath.position.y = 0.55 - grazing * 0.12 - crouch * 0.065;
    breath.rotation.x = grazing * 0.18 + (moving ? Math.sin(flight * Math.PI * 2) * 0.09 : 0);
    head.position.copy(HEAD);
    head.position.y -= grazing * 0.40 + crouch * 0.06;
    head.position.z += grazing * 0.08;
    head.rotation.set(grazing * (0.98 + Math.sin(t * 7.8) * 0.045) + Math.sin(t * 0.83 + phase) * 0.034 * live,
      Math.sin(t * 0.47 + phase) * 0.11 * live * (1 - grazing), Math.sin(t * 0.63) * 0.025 * live);
    legs.forEach((leg, i) => {
      const u = i < 2 ? Math.min(1, flight / 0.76) : clamp((flight - 0.12) / 0.88, 0, 1);
      leg.rotation.x = moving ? -(i < 2 ? 0.8 : 0.96) * Math.sin(Math.PI * u) : 0;
    });
    ears.forEach((ear, i) => {
      ear.rotation.copy(ear.userData.restRotation);
      const twitch = Math.pow(Math.max(0, Math.sin(t * 0.93 + i * 2.4 + phase)), 18) * live;
      ear.rotation.z += (i ? 1 : -1) * twitch * 0.11;
      ear.rotation.x += Math.sin(t * 1.3 + i) * 0.028 * live;
      ear.rotation.x -= scared * 0.42 + (moving ? Math.sin(flight * Math.PI) * 0.16 : 0);
    });
    const blink = Math.pow(Math.max(0, Math.cos(t * Math.PI * 2 / 5.6 + phase)), 100) * live;
    eyes.forEach(eye => { eye.scale.y = 1 - blink * 0.91; });
    nose.scale.setScalar(1 + Math.sin(t * 9) * 0.035 * live);
    root.updateMatrixWorld(true); skeleton.update();
  };
  update(0, true);
  body.computeBoundingBox(); body.computeBoundingSphere();
  // Small idle deformations stay in this conservative culling volume.
  body.boundingSphere.radius += 0.7;
  root.userData.allowedJoints = ['rabbit/body|rabbit/ear-1', 'rabbit/body|rabbit/ear1',
    'rabbit/body|rabbit/eye-1', 'rabbit/body|rabbit/eye1', 'rabbit/body|rabbit/nose',
    'rabbit/eye-1|rabbit/glint-1', 'rabbit/eye1|rabbit/glint1'];
  return { root, body, head, ears, eyes, legs, nose, update, field };
}
