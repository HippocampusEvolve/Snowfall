import * as THREE from 'three';
import { createRandom } from './generators.js';

export const PROP_TYPES = ['axe', 'pickaxe', 'hammer', 'knife', 'canteen', 'torch'];
export const PROP_NAMES = {
  axe: 'Походный топор', pickaxe: 'Кирка', hammer: 'Молоток',
  knife: 'Нож', canteen: 'Фляга', torch: 'Факел',
};
export const PACK_LAYOUT = {
  center: [0, 0, 5.5], width: 7.2, depth: 4.5, top: 1.25,
  slots: [
    [-2.3, -0.95, -0.18], [0, -0.95, 0.08], [2.3, -0.95, 0.22],
    [-2.3, 1.05, -0.25], [0, 1.05, 0.14], [2.45, 1.05, 0],
  ],
};

// All profiles are actual volumes. Edge strips meet the forged body at a
// shared contour; they are not thin decals lying over the same surface.
function prism(points, depth, bevel = 0.018) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth, steps: 1, bevelEnabled: bevel > 0,
    bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 4,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.clearGroups();
  return geometry;
}

function roundedBox(x, y, z, bevel = 0.025) {
  const bx = x / 2 - bevel;
  const by = y / 2 - bevel;
  return prism([[-bx, -by], [bx, -by], [bx, by], [-bx, by]], z - 2 * bevel, bevel);
}

// Closed radial loft, with a single vertex on each end cap, no zero-area poles.
function loft(rings, segments = 12) {
  const positions = [], indices = [], uvs = [];
  for (let j = 0; j < rings.length; j++) {
    const [y, rx, rz, cx = 0, cz = 0] = rings[j];
    for (let i = 0; i <= segments; i++) {
      const angle = i / segments * Math.PI * 2;
      positions.push(cx + Math.cos(angle) * rx, y, cz + Math.sin(angle) * rz);
      uvs.push(i / segments, j / (rings.length - 1));
    }
  }
  for (let j = 0; j < rings.length - 1; j++) {
    for (let i = 0; i < segments; i++) {
      const a = j * (segments + 1) + i, b = a + segments + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  for (const end of [0, rings.length - 1]) {
    const [y, , , x = 0, z = 0] = rings[end];
    const center = positions.length / 3;
    positions.push(x, y, z); uvs.push(0.5, 0.5);
    for (let i = 0; i < segments; i++) {
      const a = end * (segments + 1) + i;
      indices.push(...(end === 0 ? [center, a, a + 1] : [center, a + 1, a]));
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  // Average the duplicated UV seam so a smooth handle has no lighting seam.
  const normals = geometry.attributes.normal;
  for (let j = 0; j < rings.length; j++) {
    const a = j * (segments + 1), b = a + segments;
    const n = new THREE.Vector3().fromBufferAttribute(normals, a)
      .add(new THREE.Vector3().fromBufferAttribute(normals, b)).normalize();
    normals.setXYZ(a, n.x, n.y, n.z); normals.setXYZ(b, n.x, n.y, n.z);
  }
  return geometry;
}

function tube(points, radius = 0.018, segments = 32) {
  const path = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(path, segments, radius, 6, false);
}

function sharpenedStrip(inner, outer, thick) {
  const dx = inner[1][0] - inner[0][0], dy = inner[1][1] - inner[0][1];
  if (dx * (outer[0][1] - inner[0][1]) - dy * (outer[0][0] - inner[0][0]) < 0) {
    inner = [...inner].reverse(); outer = [...outer].reverse();
  }
  const pos = [], idx = [];
  for (let i = 0; i < inner.length; i++) {
    pos.push(inner[i][0], inner[i][1], thick, outer[i][0], outer[i][1], 0.009,
      inner[i][0], inner[i][1], -thick, outer[i][0], outer[i][1], -0.009);
  }
  for (let i = 0; i < inner.length - 1; i++) {
    const a = i * 4, b = a + 4;
    idx.push(a, b, a + 1, b, b + 1, a + 1,
      a + 2, a + 3, b + 2, b + 2, a + 3, b + 3,
      a + 1, b + 1, a + 3, b + 1, b + 3, a + 3);
  }
  const last = (inner.length - 1) * 4;
  idx.push(0, 1, 2, 1, 3, 2, last, last + 2, last + 1, last + 1, last + 2, last + 3);
  // Hidden back wall closes the steel strip against the core.
  for (let i = 0; i < inner.length - 1; i++) {
    const a = i * 4, b = a + 4;
    idx.push(a, a + 2, b, a + 2, b + 2, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed(); g.dispose();
  flat.computeVertexNormals();
  flat.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(flat.attributes.position.count * 2), 2));
  return flat;
}

export function createSurvivalProp(type, seed, materials, { merge = true } = {}) {
  if (!PROP_TYPES.includes(type)) throw new Error(`Unknown survival prop: ${type}`);
  const root = new THREE.Group();
  root.name = type;
  const random = createRandom(seed);
  const bend = (random() - 0.5) * 0.05;
  root.userData.allowedJoints = [];
  const part = (name, geometry, material, position = [0, 0, 0], rotation = [0, 0, 0]) => {
    const mesh = new THREE.Mesh(geometry, materials[material]);
    mesh.name = `${type}/${name}`;
    mesh.position.fromArray(position); mesh.rotation.set(...rotation);
    mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
    return mesh;
  };
  const joint = (a, b) => root.userData.allowedJoints.push([`${type}/${a}`, `${type}/${b}`].sort().join('|'));
  const handle = (height = 1.8) => {
    part('handle', loft([
      [0, 0.105, 0.075, -0.025], [0.06, 0.13, 0.084, -0.03],
      [0.18, 0.105, 0.075, -0.01], [0.48, 0.082, 0.065, 0.02],
      [0.84, 0.078, 0.062, 0.035 + bend], [height * 0.72, 0.09, 0.068, bend],
      [height, 0.10, 0.07, 0],
    ]), 'wood');
    // A continuous helix with enough embedding to read as a tight leather wrap.
    const points = [];
    for (let i = 0; i <= 100; i++) {
      const t = i / 100, a = t * Math.PI * 2 * 6.3;
      points.push([0.015 + Math.cos(a) * 0.094, 0.16 + t * 0.49, Math.sin(a) * 0.071]);
    }
    part('grip', tube(points, 0.024, 110), 'leather');
    joint('handle', 'grip');
    part('pommel', loft([[0.012, 0.14, 0.105, -0.025], [0.075, 0.15, 0.108, -0.03]], 12), 'brass');
    joint('handle', 'pommel');
  };
  const pin = (name, x, y, depth = 0.18) => {
    part(name, new THREE.CylinderGeometry(0.031, 0.031, depth, 10), 'brass', [x, y, 0], [Math.PI / 2, 0, 0]);
  };

  if (type === 'axe') {
    handle(1.81);
    const contour = [[-0.3, 1.53], [-0.3, 1.88], [0.22, 1.88], [0.53, 2.00], [0.73, 1.86], [0.72, 1.38], [0.57, 1.27], [0.38, 1.54]];
    part('head', prism(contour, 0.21, 0), 'iron');
    part('cutting-edge', sharpenedStrip([[0.53, 2], [0.73, 1.86], [0.72, 1.38], [0.57, 1.27]],
      [[0.70, 2.05], [0.94, 1.9], [0.97, 1.35], [0.73, 1.16]], 0.105), 'edge');
    part('socket', roundedBox(0.28, 0.36, 0.29, 0.035), 'iron', [0, 1.72, 0]);
    pin('head-rivet', 0, 1.72, 0.31);
    joint('handle', 'head'); joint('handle', 'socket'); joint('head', 'socket');
    joint('head-rivet', 'socket'); joint('head-rivet', 'head'); joint('head-rivet', 'handle');
  } else if (type === 'pickaxe') {
    handle(1.83);
    part('head', prism([[-1.0, 1.45], [-0.86, 1.7], [-0.49, 1.94], [-0.17, 2.0],
      [0.24, 1.97], [0.68, 1.78], [1.03, 1.42], [0.69, 1.6], [0.26, 1.75],
      [-0.23, 1.77], [-0.59, 1.65]], 0.17, 0.012), 'iron');
    part('socket', roundedBox(0.31, 0.32, 0.29), 'edge', [0, 1.86, 0]);
    pin('head-rivet', 0, 1.84, 0.32);
    joint('head', 'socket'); joint('handle', 'socket'); joint('handle', 'head');
    joint('head-rivet', 'socket'); joint('head-rivet', 'head'); joint('head-rivet', 'handle');
  } else if (type === 'hammer') {
    handle(1.45);
    part('head', roundedBox(0.89, 0.38, 0.37, 0.045), 'iron', [0, 1.47, 0]);
    part('striking-face', roundedBox(0.15, 0.405, 0.40, 0.027), 'edge', [-0.48, 1.47, 0]);
    part('back-face', roundedBox(0.13, 0.35, 0.34), 'edge', [0.47, 1.47, 0]);
    pin('head-rivet', 0, 1.46, 0.405);
    joint('head', 'handle'); joint('head', 'striking-face'); joint('head', 'back-face');
    joint('head-rivet', 'head'); joint('head-rivet', 'handle');
  } else if (type === 'knife') {
    part('tang', roundedBox(0.15, 0.75, 0.075, 0.012), 'iron', [0, 0.36, 0]);
    for (const side of [-1, 1]) {
      part(`scale${side}`, prism([[-0.095, 0.06], [0.095, 0.045], [0.11, 0.16], [0.095, 0.57],
        [0.075, 0.69], [-0.085, 0.67], [-0.12, 0.18]], 0.045, 0.025), 'wood', [0, 0, side * 0.062]);
      joint('tang', `scale${side}`);
    }
    part('guard', roundedBox(0.37, 0.075, 0.23, 0.018), 'brass', [0, 0.71, 0]);
    part('blade', prism([[-0.10, 0.74], [0.075, 0.74], [0.09, 1.22], [-0.09, 1.64], [-0.13, 1.74]], 0.072, 0), 'iron');
    part('cutting-edge', sharpenedStrip([[0.075, 0.74], [0.09, 1.22], [-0.09, 1.64], [-0.13, 1.74]],
      [[0.19, 0.74], [0.22, 1.23], [0.035, 1.59], [-0.125, 1.765]], 0.036), 'edge');
    for (const [name, y] of [['pin1', 0.20], ['pin2', 0.53]]) {
      pin(name, 0, y, 0.25);
      joint(name, 'tang'); joint(name, 'scale-1'); joint(name, 'scale1');
    }
    joint('guard', 'tang'); joint('guard', 'blade'); joint('guard', 'cutting-edge');
    joint('guard', 'scale-1'); joint('guard', 'scale1');
  } else if (type === 'canteen') {
    const profile = [[0, 0.24, 0.09], [0.07, 0.39, 0.15], [0.22, 0.45, 0.19],
      [0.65, 0.43, 0.195], [0.87, 0.32, 0.155], [0.99, 0.13, 0.10], [1.06, 0.10, 0.08]];
    part('bottle', loft(profile, 32), 'enamel');
    part('neck', loft([[1.0, 0.11, 0.095], [1.115, 0.11, 0.095]], 16), 'brass');
    part('cap', loft([[1.08, 0.132, 0.115], [1.15, 0.132, 0.115], [1.17, 0.10, 0.085]], 16), 'iron');
    const band = [[-0.08, 0.08, 0.156], [-0.08, 0.31, 0.207], [-0.08, 0.65, 0.21],
      [-0.08, 0.86, 0.168], [-0.08, 0.89, -0.168], [-0.08, 0.65, -0.21],
      [-0.08, 0.31, -0.207], [-0.08, 0.08, -0.156], [-0.08, 0.005, 0], [-0.08, 0.08, 0.156]];
    part('strap', tube(band, 0.035, 56), 'leather');
    part('buckle', prism([[-0.066, -0.07], [0.066, -0.07], [0.066, 0.07], [-0.066, 0.07]], 0.06, 0.012), 'brass', [-0.08, 0.48, 0.25]);
    part('cap-loop', tube([[0.11, 1.14, 0], [0.28, 1.17, 0], [0.38, 1.04, 0], [0.32, 0.88, 0]], 0.021, 22), 'leather');
    joint('bottle', 'neck'); joint('neck', 'cap'); joint('bottle', 'strap');
    joint('strap', 'buckle'); joint('cap-loop', 'cap'); joint('cap-loop', 'bottle');
  } else if (type === 'torch') {
    part('shaft', loft([[0, 0.1, 0.085], [0.1, 0.105, 0.09], [0.65, 0.08, 0.075, 0.025],
      [1.28, 0.105, 0.085], [1.47, 0.14, 0.11]], 10), 'wood');
    part('pitch', loft([[1.15, 0.14, 0.12], [1.32, 0.22, 0.17], [1.56, 0.20, 0.16], [1.66, 0.12, 0.10]], 12), 'coal');
    const pts = [];
    for (let i = 0; i <= 70; i++) {
      const t = i / 70, a = t * Math.PI * 2 * 4.5;
      pts.push([Math.cos(a) * (0.16 + Math.sin(t * Math.PI) * 0.05), 1.17 + t * 0.4,
        Math.sin(a) * (0.13 + Math.sin(t * Math.PI) * 0.035)]);
    }
    part('binding', tube(pts, 0.033, 80), 'cloth');
    part('collar', loft([[1.10, 0.137, 0.115], [1.17, 0.137, 0.115]], 12), 'iron');
    joint('shaft', 'pitch'); joint('pitch', 'binding'); joint('shaft', 'collar'); joint('pitch', 'collar');
    const flame = part('flame', loft([[1.5, 0.115, 0.10], [1.69, 0.24, 0.19], [1.92, 0.18, 0.13, 0.03],
      [2.15, 0.10, 0.07, -0.04], [2.43, 0.008, 0.006, 0.07]], 12), 'flame');
    flame.userData.effect = true; flame.castShadow = false; flame.receiveShadow = false;
  }
  root.userData.type = type;
  root.userData.seed = seed;
  if (merge) mergeByMaterial(root);
  return root;
}

// Static details share a draw call per material, including all wrap turns.
function mergeByMaterial(root) {
  root.updateMatrixWorld(true);
  const batches = new Map();
  for (const mesh of [...root.children]) {
    if (!mesh.isMesh || mesh.userData.effect) continue;
    let batch = batches.get(mesh.material);
    if (!batch) { batch = []; batches.set(mesh.material, batch); }
    batch.push(mesh);
  }
  for (const [material, meshes] of batches) {
    const attributes = { position: [], normal: [], uv: [] };
    for (const mesh of meshes) {
      const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
      g.applyMatrix4(mesh.matrix);
      for (const key of Object.keys(attributes)) attributes[key].push(...g.attributes[key].array);
      g.dispose(); mesh.geometry.dispose(); root.remove(mesh);
    }
    const g = new THREE.BufferGeometry();
    for (const [key, values] of Object.entries(attributes)) {
      g.setAttribute(key, new THREE.Float32BufferAttribute(values, key === 'uv' ? 2 : 3));
    }
    const merged = new THREE.Mesh(g, material);
    merged.name = `${root.name}/${material.name}`;
    merged.castShadow = true; merged.receiveShadow = true;
    root.add(merged);
  }
}

export function createSurvivalPack(seed, materials) {
  const root = new THREE.Group(); root.name = 'Survival workbench';
  const items = new Map();
  const plank = (name, dims, p, material = 'wood') => {
    const mesh = new THREE.Mesh(roundedBox(...dims, 0.035), materials[material]);
    mesh.name = name; mesh.position.fromArray(p); mesh.castShadow = true; mesh.receiveShadow = true;
    root.add(mesh);
  };
  for (let i = 0; i < 6; i++) {
    plank(`bench/plank-${i}`, [7.2, 0.17, 0.725], [0, PACK_LAYOUT.top - 0.085, -1.875 + i * 0.75]);
  }
  for (const x of [-2.8, 2.8]) {
    plank(`bench/crossbar-${x}`, [0.24, 0.23, 4.05], [x, 1.04, 0]);
    for (const z of [-1.7, 1.7]) plank(`bench/leg-${x}-${z}`, [0.22, 1.08, 0.24], [x, 0.54, z]);
  }
  PROP_TYPES.forEach((type, index) => {
    const item = createSurvivalProp(type, seed + index * 131, materials);
    const [x, z, angle] = PACK_LAYOUT.slots[index];
    if (type !== 'torch') {
      item.rotation.set(-Math.PI / 2, 0, angle);
      item.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(item);
      const center = bounds.getCenter(new THREE.Vector3());
      item.position.set(x - center.x, PACK_LAYOUT.top - bounds.min.y + 0.008, z - center.z);
    } else {
      item.position.set(x, PACK_LAYOUT.top, z);
      // Iron foot holds the displayed torch upright.
      plank('bench/torch-foot', [0.48, 0.09, 0.42], [x, PACK_LAYOUT.top + 0.045, z], 'iron');
    }
    root.add(item); items.set(type, item);
  });
  return { root, items };
}
