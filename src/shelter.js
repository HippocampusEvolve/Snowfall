// A high natural vault is still shelter. Sample the whole overburden rather
// than requiring the roof to touch the player's head.
export function caveShelter(densityAt, baseHeight, point) {
  const depth = baseHeight(point.x, point.z) - point.y;
  if (depth < 0.6) return 0;
  let roof = false;
  for (let dy = 0.4; dy <= Math.min(depth + 0.5, 40); dy += 0.4) {
    if (densityAt(point.x, point.y + dy, point.z) > 0.08) { roof = true; break; }
  }
  if (!roof) return 0;
  // Deep overburden protects large halls too; near an entrance fade smoothly.
  return Math.min(1, Math.max(0, (depth - 0.5) / 2.5));
}

export function aimedAt(cameraPosition, direction, target, reach = 2.4, dot = 0.86) {
  const dx = target.x - cameraPosition.x, dy = target.y - cameraPosition.y, dz = target.z - cameraPosition.z;
  const distance = Math.hypot(dx, dy, dz);
  return distance > 0.01 && distance <= reach &&
    (dx * direction.x + dy * direction.y + dz * direction.z) / distance >= dot;
}
