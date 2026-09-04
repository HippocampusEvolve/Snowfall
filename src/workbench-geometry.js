// Описание верстака отдельно от three - тест считает ровно те же примитивы.
export const WORKBENCH_PARTS = Object.freeze([
  ...Array.from({ length: 6 }, (_, i) => ({
    kind: 'box', role: 'floor', x: -0.79 + i * 0.316, y: 0.86, z: 0,
    w: 0.29, h: 0.1, d: 0.86,
  })),
  { kind: 'box', role: 'beam', x: -0.67, y: 0.41, z: -0.25, w: 0.13, h: 0.78, d: 0.13, rx: -0.16 },
  { kind: 'box', role: 'beam', x: -0.67, y: 0.41, z: 0.25, w: 0.13, h: 0.78, d: 0.13, rx: 0.16 },
  { kind: 'box', role: 'beam', x: 0.67, y: 0.41, z: -0.25, w: 0.13, h: 0.78, d: 0.13, rx: -0.16 },
  { kind: 'box', role: 'beam', x: 0.67, y: 0.41, z: 0.25, w: 0.13, h: 0.78, d: 0.13, rx: 0.16 },
  { kind: 'box', role: 'beam', x: -0.67, y: 0.72, z: 0, w: 0.16, h: 0.12, d: 0.96 },
  { kind: 'box', role: 'beam', x: 0.67, y: 0.72, z: 0, w: 0.16, h: 0.12, d: 0.96 },
  { kind: 'box', role: 'beam', x: -0.67, y: 0.045, z: 0, w: 0.2, h: 0.09, d: 1.04 },
  { kind: 'box', role: 'beam', x: 0.67, y: 0.045, z: 0, w: 0.2, h: 0.09, d: 1.04 },
  { kind: 'box', role: 'beam', x: 0, y: 0.34, z: 0, w: 1.42, h: 0.12, d: 0.12 },
  { kind: 'box', role: 'beam', x: 0.52, y: 0.99, z: -0.25, w: 0.3, h: 0.16, d: 0.15 },
  { kind: 'box', role: 'beam', x: 0.52, y: 0.99, z: -0.06, w: 0.3, h: 0.16, d: 0.1 },
  { kind: 'cylinder', role: 'metal', x: 0.52, y: 0.96, z: 0.02, radius: 0.018, h: 0.34, segments: 6, rx: Math.PI / 2 },
  { kind: 'cylinder', role: 'metal', x: 0.52, y: 0.96, z: 0.18, radius: 0.012, h: 0.34, segments: 6, rz: Math.PI / 2 },
]);

const triangles = (part) => part.kind === 'box' ? 12 : part.segments * 4;

export function countWorkbenchTriangles() {
  return WORKBENCH_PARTS.reduce((sum, part) => sum + triangles(part), 0);
}
