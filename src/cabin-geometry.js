// Геометрия избы считается без three, DOM и загрузчиков. На выходе лежат
// готовые индексированные буферы в метрах и план, нужный сцене и тестам.

const OLD_SCALE = 1.0545349463020333;
const OLD_CENTER_X = 0.20205235481262207;
const OLD_CENTER_Z = 0.8637917041778564;

const nx = (x) => (x - OLD_CENTER_X) * OLD_SCALE;
const nz = (z) => (z - OLD_CENTER_Z) * OLD_SCALE;

export const CABIN_TRI_LIMIT = 12_000;
export const CABIN_DRAW_LIMIT = 6;

export const DEFAULT_CABIN_SPEC = {
  seed: 0x6ca91d,
  bounds: {
    minX: -4.058859602739542,
    maxX: 4.058859602739542,
    minY: 0,
    maxY: 6.212149875036044,
    minZ: -4.8,
    maxZ: 4.8,
  },
  room: {
    x0: nx(-2.7),
    x1: nx(3.03),
    z0: nz(-2.9),
    z1: nz(2.8),
    floorY: 1.97,
  },
  wall: {
    logRadius: 0.19,
    bottomY: 1.59,
    topCenterY: 4.42,
    crowns: 11,
    cornerReach: 0.46,
  },
  roof: {
    eaveTopY: 4.62,
    ridgeTopY: 6.212149875036044,
    thickness: 0.1,
    plankCount: 30,
  },
  porch: {
    z1: 4.24,
    stepDepth: 0.46,
    stepDrop: 0.26,
  },
  door: {
    centerX: -0.9513,
    width: 1.519,
    leafWidth: 1.09,
    hingeX: -0.6,
    hingeZ: 2.07787,
    height: 2.14,
  },
  windows: [
    { wall: 'front', center: 1.06033, fixed: 1.94239, lightCenter: 0.86395, centerY: 2.51303, width: 0.91644, height: 0.91644 },
    { wall: 'back', center: -1.47079, fixed: -3.75198, lightCenter: -1.66717, centerY: 2.51303, width: 0.91644, height: 0.91644 },
    { wall: 'left', center: -0.91941, fixed: -3.06098, lightCenter: -0.72303, centerY: 2.51268, width: 0.91644, height: 0.91644 },
    { wall: 'right', center: -0.91941, fixed: 2.63484, lightCenter: -0.72303, centerY: 2.51268, width: 0.91644, height: 0.91644 },
  ],
};

function mergeSpec(spec) {
  return {
    ...DEFAULT_CABIN_SPEC,
    ...spec,
    bounds: { ...DEFAULT_CABIN_SPEC.bounds, ...spec.bounds },
    room: { ...DEFAULT_CABIN_SPEC.room, ...spec.room },
    wall: { ...DEFAULT_CABIN_SPEC.wall, ...spec.wall },
    roof: { ...DEFAULT_CABIN_SPEC.roof, ...spec.roof },
    porch: { ...DEFAULT_CABIN_SPEC.porch, ...spec.porch },
    door: { ...DEFAULT_CABIN_SPEC.door, ...spec.door },
    windows: spec.windows ? spec.windows.map((w) => ({ ...w })) : DEFAULT_CABIN_SPEC.windows.map((w) => ({ ...w })),
  };
}

function randomSource(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function bucket(name, material) {
  return { name, material, position: [], normal: [], uv: [], index: [] };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function unit(v) {
  const d = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / d, v[1] / d, v[2] / d];
}

function addFace(out, points, normal, uvs) {
  const seen = cross(sub(points[1], points[0]), sub(points[2], points[1]));
  const order = dot(seen, normal) >= 0 ? [0, 1, 2, 3] : [0, 3, 2, 1];
  const base = out.position.length / 3;
  for (const i of order) {
    out.position.push(...points[i]);
    out.normal.push(...normal);
    out.uv.push(...uvs[i]);
  }
  out.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

function addTriangle(out, points, normal, uvs) {
  const seen = cross(sub(points[1], points[0]), sub(points[2], points[0]));
  const order = dot(seen, normal) >= 0 ? [0, 1, 2] : [0, 2, 1];
  const base = out.position.length / 3;
  for (const i of order) {
    out.position.push(...points[i]);
    out.normal.push(...normal);
    out.uv.push(...uvs[i]);
  }
  out.index.push(base, base + 1, base + 2);
}

function uvRect(du, dv, swap) {
  return swap
    ? [[0, 0], [0, du], [dv, du], [dv, 0]]
    : [[0, 0], [du, 0], [du, dv], [0, dv]];
}

function addBox(out, p) {
  const hx = p.w / 2, hy = p.h / 2, hz = p.d / 2;
  const c = Math.cos(p.rz || 0), s = Math.sin(p.rz || 0);
  const point = ([x, y, z]) => [p.x + x * c - y * s, p.y + x * s + y * c, p.z + z];
  const normal = ([x, y, z]) => [x * c - y * s, x * s + y * c, z];
  const faces = [
    { n: [1, 0, 0], u: 'z', v: 'y', du: p.d, dv: p.h, q: [[hx, -hy, -hz], [hx, -hy, hz], [hx, hy, hz], [hx, hy, -hz]] },
    { n: [-1, 0, 0], u: 'z', v: 'y', du: p.d, dv: p.h, q: [[-hx, -hy, hz], [-hx, -hy, -hz], [-hx, hy, -hz], [-hx, hy, hz]] },
    { n: [0, 1, 0], u: 'x', v: 'z', du: p.w, dv: p.d, q: [[-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, -1, 0], u: 'x', v: 'z', du: p.w, dv: p.d, q: [[-hx, -hy, hz], [hx, -hy, hz], [hx, -hy, -hz], [-hx, -hy, -hz]] },
    { n: [0, 0, 1], u: 'x', v: 'y', du: p.w, dv: p.h, q: [[-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz]] },
    { n: [0, 0, -1], u: 'x', v: 'y', du: p.w, dv: p.h, q: [[hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz]] },
  ];
  for (const f of faces) {
    addFace(out, f.q.map(point), normal(f.n), uvRect(f.du, f.dv, p.along === f.u));
  }
}

function addLog(out, from, to, radius, rand, segments = 8) {
  const axis = unit(sub(to, from));
  const sideA = [0, 1, 0];
  const sideB = unit(cross(axis, sideA));
  const length = Math.hypot(...sub(to, from));
  const ring0 = [], ring1 = [];
  for (let i = 0; i < segments; i++) {
    ring0.push(radius * (0.972 + rand() * 0.056));
    ring1.push(radius * (0.972 + rand() * 0.056));
  }
  const at = (base, angle, r) => [
    base[0] + sideA[0] * Math.cos(angle) * r + sideB[0] * Math.sin(angle) * r,
    base[1] + sideA[1] * Math.cos(angle) * r + sideB[1] * Math.sin(angle) * r,
    base[2] + sideA[2] * Math.cos(angle) * r + sideB[2] * Math.sin(angle) * r,
  ];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const mid = (a0 + a1) / 2;
    const j = (i + 1) % segments;
    const n = unit([
      sideA[0] * Math.cos(mid) + sideB[0] * Math.sin(mid),
      sideA[1] * Math.cos(mid) + sideB[1] * Math.sin(mid),
      sideA[2] * Math.cos(mid) + sideB[2] * Math.sin(mid),
    ]);
    addFace(
      out,
      [at(from, a0, ring0[i]), at(to, a0, ring1[i]), at(to, a1, ring1[j]), at(from, a1, ring0[j])],
      n,
      [[a0 * radius, 0], [a0 * radius, length], [a1 * radius, length], [a1 * radius, 0]]
    );
    addTriangle(
      out,
      [from, at(from, a0, ring0[i]), at(from, a1, ring0[j])],
      axis.map((v) => -v),
      [[0, 0], [Math.cos(a0) * radius, Math.sin(a0) * radius], [Math.cos(a1) * radius, Math.sin(a1) * radius]]
    );
    addTriangle(
      out,
      [to, at(to, a1, ring1[j]), at(to, a0, ring1[i])],
      axis,
      [[0, 0], [Math.cos(a1) * radius, Math.sin(a1) * radius], [Math.cos(a0) * radius, Math.sin(a0) * radius]]
    );
  }
}

function subtractIntervals(from, to, cuts) {
  let spans = [[from, to]];
  for (const cut of cuts) {
    const next = [];
    for (const [a, b] of spans) {
      if (cut[1] <= a || cut[0] >= b) next.push([a, b]);
      else {
        if (cut[0] > a) next.push([a, cut[0]]);
        if (cut[1] < b) next.push([cut[1], b]);
      }
    }
    spans = next;
  }
  return spans.filter(([a, b]) => b - a > 0.08);
}

function finish(out) {
  return {
    name: out.name,
    material: out.material,
    position: new Float32Array(out.position),
    normal: new Float32Array(out.normal),
    uv: new Float32Array(out.uv),
    index: new Uint32Array(out.index),
    triangles: out.index.length / 3,
  };
}

function addWindowGeometry(glass, beam, room, w) {
  const halfW = w.width / 2, halfH = w.height / 2;
  const y0 = w.centerY - halfH, y1 = w.centerY + halfH;
  const frame = 0.14, depth = 0.24;
  if (w.wall === 'front' || w.wall === 'back') {
    const z = w.fixed ?? (w.wall === 'front' ? room.z1 : room.z0);
    const out = w.wall === 'front' ? 1 : -1;
    addFace(
      glass,
      [[w.center - halfW, y0, z], [w.center + halfW, y0, z], [w.center + halfW, y1, z], [w.center - halfW, y1, z]],
      [0, 0, out],
      uvRect(w.width, w.height, false)
    );
    for (const x of [w.center - halfW - frame / 2, w.center + halfW + frame / 2, w.center]) {
      addBox(beam, { x, y: w.centerY, z, w: x === w.center ? 0.075 : frame, h: w.height + frame * 2, d: depth, along: 'y' });
    }
    for (const y of [y0 - frame / 2, y1 + frame / 2, w.centerY]) {
      addBox(beam, { x: w.center, y, z, w: w.width + frame * 2, h: y === w.centerY ? 0.075 : frame, d: depth, along: 'x' });
    }
  } else {
    const x = w.fixed ?? (w.wall === 'right' ? room.x1 : room.x0);
    const out = w.wall === 'right' ? 1 : -1;
    addFace(
      glass,
      [[x, y0, w.center + halfW], [x, y0, w.center - halfW], [x, y1, w.center - halfW], [x, y1, w.center + halfW]],
      [out, 0, 0],
      uvRect(w.width, w.height, false)
    );
    for (const z of [w.center - halfW - frame / 2, w.center + halfW + frame / 2, w.center]) {
      addBox(beam, { x, y: w.centerY, z, w: depth, h: w.height + frame * 2, d: z === w.center ? 0.075 : frame, along: 'y' });
    }
    for (const y of [y0 - frame / 2, y1 + frame / 2, w.centerY]) {
      addBox(beam, { x, y, z: w.center, w: depth, h: y === w.centerY ? 0.075 : frame, d: w.width + frame * 2, along: 'z' });
    }
  }
}

function boundsOf(meshes, door) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const [name, mesh] of Object.entries(meshes)) {
    const p = mesh.position;
    for (let i = 0; i < p.length; i += 3) {
      const dx = name === 'door' ? door.hingeX : 0;
      const dz = name === 'door' ? door.hingeZ : 0;
      const values = [p[i] + dx, p[i + 1], p[i + 2] + dz];
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], values[k]);
        max[k] = Math.max(max[k], values[k]);
      }
    }
  }
  return { min, max, size: max.map((v, i) => v - min[i]) };
}

/** Собрать метрическую геометрию и план избы. */
export function buildCabin(spec = {}) {
  const s = mergeSpec(spec);
  const rand = randomSource(s.seed);
  const logs = bucket('logs', 'log');
  const beam = bucket('beam', 'beam');
  const boards = bucket('boards', 'floor');
  const doorBoards = bucket('door', 'floor');
  const roof = bucket('roof', 'roof');
  const glass = bucket('glass', 'glass');
  const room = s.room;
  const door = {
    ...s.door,
    x0: s.door.centerX - s.door.width / 2,
    x1: s.door.centerX + s.door.width / 2,
    y0: room.floorY - 0.01,
    y1: room.floorY - 0.01 + s.door.height,
    wallZ: room.z1,
  };
  const windowPlan = s.windows.map((w) => ({
    ...w,
    y0: w.centerY - w.height / 2,
    y1: w.centerY + w.height / 2,
  }));

  const crownStep = (s.wall.topCenterY - s.wall.bottomY) / (s.wall.crowns - 1);
  for (let crown = 0; crown < s.wall.crowns; crown++) {
    const y = s.wall.bottomY + crown * crownStep + (rand() - 0.5) * 0.018;
    const r = s.wall.logRadius * (0.975 + rand() * 0.05);
    const reach = s.wall.cornerReach + (crown % 2 ? 0.04 : -0.02);
    for (const wallName of ['front', 'back']) {
      const z = wallName === 'front' ? room.z1 : room.z0;
      const openings = windowPlan.filter((w) => w.wall === wallName && y + r > w.y0 && y - r < w.y1)
        .map((w) => [w.center - w.width / 2, w.center + w.width / 2]);
      if (wallName === 'front' && y + r > door.y0 && y - r < door.y1) openings.push([door.x0, door.x1]);
      for (const [a, b] of subtractIntervals(room.x0 - reach, room.x1 + reach, openings)) {
        addLog(logs, [a, y, z], [b, y, z], r, rand);
      }
    }
    for (const wallName of ['left', 'right']) {
      const x = wallName === 'left' ? room.x0 : room.x1;
      const openings = windowPlan.filter((w) => w.wall === wallName && y + r > w.y0 && y - r < w.y1)
        .map((w) => [w.center - w.width / 2, w.center + w.width / 2]);
      for (const [a, b] of subtractIntervals(room.z0 - reach, room.z1 + reach, openings)) {
        addLog(logs, [x, y, a], [x, y, b], r, rand);
      }
    }
  }

  const gableStep = 0.25;
  for (let y = s.wall.topCenterY + gableStep; y <= s.roof.ridgeTopY - s.wall.logRadius; y += gableStep) {
    const k = (s.roof.ridgeTopY - y) / (s.roof.ridgeTopY - s.roof.eaveTopY);
    const half = Math.max(0.22, ((room.x1 - room.x0) / 2 + 0.18) * k);
    const center = (room.x0 + room.x1) / 2;
    for (const z of [room.z0, room.z1]) addLog(logs, [center - half, y, z], [center + half, y, z], s.wall.logRadius * 0.96, rand);
  }

  for (const w of windowPlan) addWindowGeometry(glass, beam, room, w);

  const frame = 0.17;
  for (const x of [door.x0 - frame / 2, door.x1 + frame / 2]) {
    addBox(beam, { x, y: (door.y0 + door.y1) / 2, z: room.z1 + 0.12, w: frame, h: door.height + frame * 2, d: 0.28, along: 'y' });
  }
  addBox(beam, { x: door.centerX, y: door.y1 + frame / 2, z: room.z1 + 0.12, w: door.width + frame * 2, h: frame, d: 0.28, along: 'x' });

  const insideW = room.x1 - room.x0 - 0.16;
  const insideD = room.z1 - room.z0 - 0.16;
  const floorCount = Math.ceil(insideW / 0.235);
  for (let i = 0; i < floorCount; i++) {
    const w = insideW / floorCount;
    addBox(boards, { x: room.x0 + 0.08 + (i + 0.5) * w, y: room.floorY - 0.05, z: (room.z0 + room.z1) / 2, w: w - 0.012, h: 0.1, d: insideD, along: 'z' });
  }
  const porchDepth = s.porch.z1 - room.z1;
  const porchCount = Math.ceil(porchDepth / 0.235);
  for (let i = 0; i < porchCount; i++) {
    const d = porchDepth / porchCount;
    addBox(boards, { x: (room.x0 + room.x1) / 2, y: room.floorY - 0.05, z: room.z1 + (i + 0.5) * d, w: room.x1 - room.x0 + 0.08, h: 0.1, d: d - 0.012, along: 'x' });
  }
  const stepTop = room.floorY - s.porch.stepDrop;
  addBox(boards, {
    x: door.centerX,
    y: stepTop - 0.09,
    z: s.porch.z1 + s.porch.stepDepth / 2,
    w: door.width + 0.46,
    h: 0.18,
    d: s.porch.stepDepth,
    along: 'x',
  });

  const postTop = s.roof.eaveTopY - 0.08;
  for (const x of [room.x0 + 0.11, room.x1 - 0.11]) {
    addBox(beam, { x, y: postTop / 2, z: s.porch.z1 - 0.1, w: 0.2, h: postTop, d: 0.2, along: 'y' });
  }
  addBox(beam, { x: (room.x0 + room.x1) / 2, y: postTop - 0.09, z: s.porch.z1 - 0.1, w: room.x1 - room.x0 + 0.22, h: 0.18, d: 0.2, along: 'x' });

  const roofRise = s.roof.ridgeTopY - s.roof.eaveTopY;
  let angle = Math.atan2(roofRise, s.bounds.maxX);
  const run = s.bounds.maxX - (s.roof.thickness / 2) * Math.sin(angle);
  angle = Math.atan2(roofRise, run);
  const slopeLength = Math.hypot(run, roofRise);
  const ridgeLineY = s.roof.ridgeTopY - (s.roof.thickness / 2) * Math.cos(angle);
  const eaveLineY = ridgeLineY - roofRise;
  const roofDepth = s.bounds.maxZ - s.bounds.minZ;
  const plankDepth = roofDepth / s.roof.plankCount;
  for (let i = 0; i < s.roof.plankCount; i++) {
    const z = s.bounds.minZ + (i + 0.5) * plankDepth;
    addBox(roof, { x: run / 2, y: (ridgeLineY + eaveLineY) / 2, z, w: slopeLength, h: s.roof.thickness, d: plankDepth - 0.008, rz: -angle, along: 'x' });
    addBox(roof, { x: -run / 2, y: (ridgeLineY + eaveLineY) / 2, z, w: slopeLength, h: s.roof.thickness, d: plankDepth - 0.008, rz: angle, along: 'x' });
  }

  const rafterCount = 11;
  for (let i = 0; i < rafterCount; i++) {
    const z = s.bounds.minZ + 0.28 + (i * (roofDepth - 0.56)) / (rafterCount - 1);
    addBox(beam, { x: run / 2, y: (ridgeLineY + eaveLineY) / 2 - 0.1, z, w: slopeLength, h: 0.13, d: 0.13, rz: -angle, along: 'x' });
    addBox(beam, { x: -run / 2, y: (ridgeLineY + eaveLineY) / 2 - 0.1, z, w: slopeLength, h: 0.13, d: 0.13, rz: angle, along: 'x' });
  }
  addBox(beam, { x: 0, y: ridgeLineY - 0.14, z: 0, w: 0.18, h: 0.22, d: roofDepth - 0.34, along: 'z' });

  const doorPlanks = 5;
  const plankW = door.leafWidth / doorPlanks;
  for (let i = 0; i < doorPlanks; i++) {
    addBox(doorBoards, {
      x: -door.leafWidth + (i + 0.5) * plankW,
      y: door.y0 + door.height / 2,
      z: 0,
      w: plankW - 0.012,
      h: door.height - 0.04,
      d: 0.085,
      along: 'y',
    });
  }
  for (const y of [door.y0 + 0.27, door.y0 + door.height / 2, door.y1 - 0.27]) {
    addBox(doorBoards, { x: -door.leafWidth / 2, y, z: -0.065, w: door.leafWidth - 0.12, h: 0.12, d: 0.075, along: 'x' });
  }

  const meshes = {
    logs: finish(logs),
    beam: finish(beam),
    boards: finish(boards),
    door: finish(doorBoards),
    roof: finish(roof),
    glass: finish(glass),
  };
  door.hingeX = s.door.hingeX;
  door.hingeZ = s.door.hingeZ;

  const wallColliders = [
    { side: 'left', x1: room.x0, z1: room.z0, x2: room.x0, z2: room.z1, r: s.wall.logRadius },
    { side: 'right', x1: room.x1, z1: room.z0, x2: room.x1, z2: room.z1, r: s.wall.logRadius },
    { side: 'back', x1: room.x0, z1: room.z0, x2: room.x1, z2: room.z0, r: s.wall.logRadius },
    { side: 'front-left', x1: room.x0, z1: room.z1, x2: door.x0, z2: room.z1, r: s.wall.logRadius },
    { side: 'front-right', x1: door.x1, z1: room.z1, x2: room.x1, z2: room.z1, r: s.wall.logRadius },
  ];
  const porchColliders = [
    { x1: room.x0, z1: room.z1, x2: room.x0, z2: s.porch.z1, r: 0.12, underFloor: true },
    { x1: room.x1, z1: room.z1, x2: room.x1, z2: s.porch.z1 - 0.5, r: 0.12, underFloor: true },
    { x1: room.x0, z1: s.porch.z1, x2: door.x0 - 0.18, z2: s.porch.z1, r: 0.12, underFloor: true },
    { x1: door.x1 + 0.18, z1: s.porch.z1, x2: room.x1, z2: s.porch.z1, r: 0.12, underFloor: true },
  ];
  const triangles = Object.values(meshes).reduce((sum, mesh) => sum + mesh.triangles, 0);
  const roofTriangles = meshes.roof.triangles;
  const materials = ['log', 'beam', 'floor', 'roof', 'glass'];
  const layout = {
    bounds: boundsOf(meshes, door),
    targetBounds: s.bounds,
    room: { ...room },
    door,
    windows: windowPlan,
    porch: { ...s.porch, stepTop },
    roof: { hx: s.bounds.maxX, hz: roofDepth / 2, topY: s.roof.ridgeTopY, centerX: 0, centerZ: 0 },
    wallColliders,
    porchColliders,
  };
  return {
    meshes,
    layout,
    stats: {
      triangles,
      trianglesWithSnow: triangles + roofTriangles,
      drawCalls: 5,
      drawCallsWithSnow: 6,
      materials,
      materialCount: materials.length,
    },
  };
}
