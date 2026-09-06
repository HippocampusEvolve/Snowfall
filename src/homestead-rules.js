// Physical members, in metres. A placed member is the inventory item itself;
// there is no building template and no voxel stroke hidden behind placement.
export const MEMBER = Object.freeze({
  beam: Object.freeze({ length: 2.4, height: 0.28, width: 0.28 }),
  roof: Object.freeze({ length: 2.64, height: 0.10, width: 0.36 }),
  block: Object.freeze({ length: 0.6, height: 0.30, width: 0.30 }),
});
export const MAX_MEMBERS = 1024;
export const BUILD_REACH = 3.4;
const EPS = 0.025;
const FOUNDATION_EMBED = 0.17;
const GROUND_CONTACT = 0.01;
const finite = (value) => Number.isFinite(value) && Math.abs(value) < 10000;

export function quarterYaw(yaw) {
  return ((Math.round(yaw / (Math.PI / 2)) % 2) + 2) % 2 * Math.PI / 2;
}

export function memberRecord(value, kind = value?.kind) {
  if (!value || !['timber', 'block'].includes(kind)) return null;
  const form = value.form || (kind === 'block' ? 'block' : 'beam');
  if (!MEMBER[form] || (kind === 'block') !== (form === 'block')) return null;
  const p = value.position || value;
  if (![p.x, p.y, p.z, value.yaw ?? 0].every(finite)) return null;
  return {
    kind, form, x: p.x, y: p.y, z: p.z, yaw: quarterYaw(value.yaw ?? 0),
    ...(Number.isSafeInteger(value.id) && value.id > 0 ? { id: value.id } : {}),
  };
}

export function localPoint(piece, x, z) {
  const c = Math.cos(piece.yaw), s = Math.sin(piece.yaw);
  return { x: (x - piece.x) * c - (z - piece.z) * s,
    z: (x - piece.x) * s + (z - piece.z) * c };
}

export function worldPoint(piece, x, z) {
  const c = Math.cos(piece.yaw), s = Math.sin(piece.yaw);
  return { x: piece.x + x * c + z * s, z: piece.z - x * s + z * c };
}

export function containsXZ(piece, x, z, margin = 0) {
  const p = localPoint(piece, x, z), d = MEMBER[piece.form];
  return Math.abs(p.x) <= d.length / 2 + margin && Math.abs(p.z) <= d.width / 2 + margin;
}

export function memberBounds(piece) {
  const d = MEMBER[piece.form];
  const alongX = Math.abs(Math.cos(piece.yaw)) > 0.5;
  const hx = (alongX ? d.length : d.width) / 2;
  const hz = (alongX ? d.width : d.length) / 2;
  return { x0: piece.x - hx, x1: piece.x + hx,
    y0: piece.y - d.height / 2, y1: piece.y + d.height / 2,
    z0: piece.z - hz, z1: piece.z + hz };
}

export function supportPoints(piece) {
  const d = MEMBER[piece.form];
  // A roof projects 12 cm beyond each wall. Beam ends bear in the crossing
  // crown; stone needs support under all four corners, not just its centre.
  const inset = piece.form === 'roof' ? 0.12 : piece.form === 'beam' ? 0.08 : 0.055;
  if (piece.form === 'block') return [-1, 1].flatMap((sx) => [-1, 1].map((sz) =>
    worldPoint(piece, sx * (d.length / 2 - inset), sz * (d.width / 2 - inset))));
  return [-1, 1].map((sign) => worldPoint(piece, sign * (d.length / 2 - inset), 0));
}

export function hasSupport(piece, pieces, groundAt, groundGap = GROUND_CONTACT) {
  const bottom = memberBounds(piece).y0;
  return supportPoints(piece).every(({ x, z }) => {
    const ground = groundAt(x, z);
    // Snow may later bury the foundation. Burial does not remove its support
    // or invalidate a saved wall; only fresh placement forbids penetration.
    if (piece.form !== 'roof' && Number.isFinite(ground) && bottom <= ground + groundGap) return true;
    return pieces.some((other) => other !== piece && other.form !== 'roof' &&
      Math.abs(memberBounds(other).y1 - bottom) < EPS && containsXZ(other, x, z, 0.012));
  });
}

function terrainHeights(piece, groundAt) {
  const d = MEMBER[piece.form], steps = Math.ceil(d.length / 0.24);
  const points = [{ x: piece.x, z: piece.z }];
  // Include the physical ends and corners, not just the inset bearing points:
  // an end or the near edge must not hang above a sloping snow surface.
  for (let i = 0; i <= steps; i++) points.push(worldPoint(piece, -d.length / 2 + i * d.length / steps, 0));
  for (const x of [-d.length / 2, 0, d.length / 2]) {
    for (const z of [-d.width / 2, d.width / 2]) points.push(worldPoint(piece, x, z));
  }
  return points.map(({ x, z }) => groundAt(x, z));
}

export function groundedPlacement(kind, x, z, yaw, groundAt) {
  const piece = memberRecord({ kind, x, y: 0, z, yaw });
  if (!piece) return null;
  const heights = terrainHeights(piece, groundAt);
  if (!heights.every(Number.isFinite) || Math.max(...heights) - Math.min(...heights) + GROUND_CONTACT > FOUNDATION_EMBED) return null;
  // The heavy foundation settles slightly into snow. Taking the highest
  // sample left the opposite end visibly floating; the low side now bears
  // on the surface and the high side is buried by a bounded amount.
  piece.y = Math.min(...heights) - GROUND_CONTACT + MEMBER[piece.form].height / 2;
  return piece;
}

function overlaps(a, b) {
  const aa = memberBounds(a), bb = memberBounds(b);
  return Math.min(aa.x1, bb.x1) - Math.max(aa.x0, bb.x0) > 0.014 &&
    Math.min(aa.y1, bb.y1) - Math.max(aa.y0, bb.y0) > 0.014 &&
    Math.min(aa.z1, bb.z1) - Math.max(aa.z0, bb.z0) > 0.014;
}

function isCorner(a, b) {
  if (a.form !== 'beam' || b.form !== 'beam' || Math.abs(a.y - b.y) > EPS ||
      Math.abs(a.yaw - b.yaw) < 0.5) return false;
  // Crossing ends form a notched corner. Crossing the middle of an existing
  // beam would create a solid wall intersection, and is refused.
  const pa = localPoint(a, b.x, b.z), pb = localPoint(b, a.x, a.z);
  return Math.abs(Math.abs(pa.x) - MEMBER.beam.length / 2) < 0.16 &&
    Math.abs(Math.abs(pb.x) - MEMBER.beam.length / 2) < 0.16;
}

export function intersectsAvoid(piece, avoid = []) {
  const d = MEMBER[piece.form];
  return avoid.some((area) => {
    if (![area.x, area.z, area.r].every(Number.isFinite)) return false;
    const p = localPoint(piece, area.x, area.z);
    return Math.hypot(Math.max(0, Math.abs(p.x) - d.length / 2),
      Math.max(0, Math.abs(p.z) - d.width / 2)) < area.r;
  });
}

export function intersectsPlayer(piece, position, radius = 0.3, height = 1.7) {
  if (!position) return false;
  const box = memberBounds(piece);
  if (position.y + height <= box.y0 || position.y >= box.y1) return false;
  const local = localPoint(piece, position.x, position.z), d = MEMBER[piece.form];
  return Math.hypot(Math.max(0, Math.abs(local.x) - d.length / 2),
    Math.max(0, Math.abs(local.z) - d.width / 2)) < radius;
}

function pointSegmentDistance2(x, z, a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
  return (x - a.x - t * dx) ** 2 + (z - a.z - t * dz) ** 2;
}

function segmentRectangleDistance2(a, b, hx, hz) {
  // Intersect the centre segment with the member's local rectangle first.
  // End-point checks alone would let a long beam cut through a tree/wall.
  let enter = 0, leave = 1;
  for (const [start, delta, half] of [[a.x, b.x - a.x, hx], [a.z, b.z - a.z, hz]]) {
    if (Math.abs(delta) < 1e-10) {
      if (Math.abs(start) > half) { enter = 2; break; }
    } else {
      const t0 = (-half - start) / delta, t1 = (half - start) / delta;
      enter = Math.max(enter, Math.min(t0, t1));
      leave = Math.min(leave, Math.max(t0, t1));
    }
  }
  if (enter <= leave) return 0;
  const pointBox = (p) => Math.max(0, Math.abs(p.x) - hx) ** 2 + Math.max(0, Math.abs(p.z) - hz) ** 2;
  return Math.min(pointBox(a), pointBox(b),
    ...[-hx, hx].flatMap(x => [-hz, hz].map(z => pointSegmentDistance2(x, z, a, b))));
}

export function intersectsObstacles(piece, obstacles = []) {
  const bounds = memberBounds(piece), d = MEMBER[piece.form];
  return obstacles.some((obstacle) => {
    if (!obstacle || !Number.isFinite(obstacle.r) || obstacle.r < 0) return false;
    // A beam may sit ON a low support, or span safely above it. The same
    // collider remains an obstacle to a lower wall member crossing its body.
    if (Number.isFinite(obstacle.y1) && bounds.y0 >= obstacle.y1 - EPS) return false;
    if (Number.isFinite(obstacle.y0) && bounds.y1 <= obstacle.y0 + EPS) return false;
    let a, b;
    if (obstacle.x2 !== undefined) {
      if (![obstacle.x1, obstacle.z1, obstacle.x2, obstacle.z2].every(Number.isFinite)) return false;
      a = localPoint(piece, obstacle.x1, obstacle.z1);
      b = localPoint(piece, obstacle.x2, obstacle.z2);
    } else {
      if (![obstacle.x, obstacle.z].every(Number.isFinite)) return false;
      a = b = localPoint(piece, obstacle.x, obstacle.z);
    }
    const distance2 = segmentRectangleDistance2(a, b, d.length / 2, d.width / 2);
    return distance2 < Math.max(0.002, obstacle.r - 0.012) ** 2;
  });
}

export function canPlaceMember(piece, pieces, { groundAt, avoid = [], obstacles = [], playerPosition, restoring = false } = {}) {
  if (!memberRecord(piece) || pieces.length >= MAX_MEMBERS || typeof groundAt !== 'function') return false;
  if (intersectsAvoid(piece, avoid) || intersectsPlayer(piece, playerPosition)) return false;
  if (!restoring && intersectsObstacles(piece, obstacles)) return false;
  if (pieces.some((other) => overlaps(piece, other) && !isCorner(piece, other))) return false;
  const bottom = memberBounds(piece).y0;
  // A foundation may seat into the snow, but cannot tunnel through a bank.
  // Roof boards still require clear terrain and structural support at both ends.
  const embed = piece.form === 'roof' ? EPS : FOUNDATION_EMBED;
  if (terrainHeights(piece, groundAt).some(y => !Number.isFinite(y) || (!restoring && y > bottom + embed + 1e-8))) return false;
  if (!restoring && piece.form === 'roof' && bottom - groundAt(piece.x, piece.z) < 1.9) return false;
  // Old local saves used a 17 cm ground tolerance. Keep those records
  // readable; new placements must actually reach the snow surface.
  return hasSupport(piece, pieces, groundAt, restoring ? FOUNDATION_EMBED : GROUND_CONTACT);
}

export function canRemoveMember(piece, pieces, groundAt) {
  if (!pieces.includes(piece)) return false;
  const rest = pieces.filter((entry) => entry !== piece);
  // The player has to dismantle a wall from the top. Refusing the operation
  // keeps both the support and inventory unchanged; nothing silently falls.
  const top = memberBounds(piece).y1;
  return rest.filter((entry) => Math.abs(memberBounds(entry).y0 - top) < EPS)
    .every((entry) => hasSupport(entry, rest, groundAt));
}

export function validateHomestead(snapshot, options) {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.pieces) ||
      snapshot.pieces.length > MAX_MEMBERS) return null;
  const values = snapshot.pieces.map((piece) => memberRecord(piece));
  if (values.some((piece) => !piece || !piece.id || piece.id > 1000000000) ||
      new Set(values.map((piece) => piece.id)).size !== values.length) return null;
  if (snapshot.pieces.some((piece) => Math.abs(Math.sin((piece.yaw ?? 0) * 2)) > 0.0001)) return null;
  // Height order makes a save independent of insertion order while ensuring
  // each load-bearing member exists before the member it carries.
  values.sort((a, b) => memberBounds(a).y0 - memberBounds(b).y0 || a.id - b.id);
  const accepted = [];
  for (const value of values) {
    if (!canPlaceMember(value, accepted, { ...options, restoring: true })) return null;
    accepted.push(value);
  }
  return accepted;
}
