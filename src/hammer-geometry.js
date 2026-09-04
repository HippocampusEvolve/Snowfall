// Описание молота отдельно от three - лимит модели проверяется на Node.
export const HAMMER_PARTS = Object.freeze([
  { kind: 'cylinder', role: 'wood', radiusTop: 0.026, radiusBottom: 0.035, h: 0.92, segments: 8, x: 0.2, y: 0.5 },
  { kind: 'box', role: 'metal', w: 0.34, h: 0.16, d: 0.17, x: 0.13, y: 0.03 },
  { kind: 'cylinder', role: 'metal', radiusTop: 0.07, radiusBottom: 0.055, h: 0.2, segments: 8, x: 0.39, y: 0.03, rz: Math.PI / 2 },
  { kind: 'cylinder', role: 'metal', radiusTop: 0.075, radiusBottom: 0.075, h: 0.055, segments: 8, x: -0.07, y: 0.03, rz: Math.PI / 2 },
  { kind: 'cylinder', role: 'wood', radiusTop: 0.042, radiusBottom: 0.035, h: 0.09, segments: 8, x: 0.2, y: 1.005 },
]);

const triangles = (part) => part.kind === 'box' ? 12 : part.segments * 4;

export function countHammerTriangles() {
  return HAMMER_PARTS.reduce((sum, part) => sum + triangles(part), 0);
}
