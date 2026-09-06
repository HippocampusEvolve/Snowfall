import { createGameProp, disposeModel, geometryStats } from './props/lab/tools.js';

// The actual laboratory mesh, including cloth binding and volumetric flame.
let triangles;
export function countTorchTriangles() {
  if (triangles === undefined) {
    const model = createGameProp('torch');
    triangles = geometryStats(model).triangles;
    disposeModel(model);
  }
  return triangles;
}
