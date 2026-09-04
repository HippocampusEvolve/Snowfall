// Геометрия факела считается без three и совпадает с примитивами модели.
export const TORCH_PARTS = Object.freeze([
  { kind: 'cylinder', role: 'wood', radiusTop: 0.021, radiusBottom: 0.03, h: 0.78, segments: 8, y: 0.39 },
  { kind: 'cylinder', role: 'wrap', radiusTop: 0.056, radiusBottom: 0.048, h: 0.18, segments: 10, y: 0.79 },
  { kind: 'icosahedron', role: 'ember', radius: 0.052, detail: 0, y: 0.9 },
  { kind: 'plane', role: 'flame', w: 0.19, h: 0.34, y: 1.08, ry: 0 },
  { kind: 'plane', role: 'flame', w: 0.19, h: 0.34, y: 1.08, ry: Math.PI / 2 },
]);

function triangles(part) {
  if (part.kind === 'cylinder') return part.segments * 4;
  if (part.kind === 'icosahedron') return 20 * 4 ** part.detail;
  return 2;
}

export function countTorchTriangles() {
  return TORCH_PARTS.reduce((sum, part) => sum + triangles(part), 0);
}
