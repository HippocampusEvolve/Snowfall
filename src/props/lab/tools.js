import * as THREE from 'three';
import { createSurvivalProp } from './survival-props.js';
import { createSurvivalMaterials } from './materials.js';

// Physical dimensions in metres. A working point remains the HeldTool origin;
// the grip is measured on the actual bent handle, not assumed to be at x=z=0.
export const LAB_TOOLS = Object.freeze({
  axe: { scale: 0.39, strike: [0.96, 1.58, 0], gripY: 0.47 },
  pickaxe: { scale: 0.39, strike: [-1.0, 1.45, 0], gripY: 0.47 },
  hammer: { scale: 0.43, strike: [-0.565, 1.47, 0], gripY: 0.45 },
  torch: { scale: 0.32, strike: [0, 0, 0], gripY: 0.45 },
});

export function createGameProp(type) {
  const spec = LAB_TOOLS[type];
  const model = createSurvivalProp(type, 7319, createSurvivalMaterials());
  const root = new THREE.Group();
  root.name = `lab/${type}`;
  root.add(model);
  model.scale.setScalar(spec.scale);
  if (type !== 'torch') model.rotation.set(0, type === 'axe' ? -Math.PI / 2 : Math.PI / 2, Math.PI);
  model.updateMatrix();
  const strike = new THREE.Vector3(...spec.strike).applyMatrix4(model.matrix);
  model.position.sub(strike);
  model.updateMatrix();
  root.userData.grip = new THREE.Vector3(0.02, spec.gripY, 0).applyMatrix4(model.matrix);
  root.userData.labModel = model;
  root.userData.flame = model.getObjectByName('torch/flame') ?? null;
  return root;
}

export function labToolTip(type, rest, handPosition) {
  const spec = LAB_TOOLS[type];
  const rotation = new THREE.Euler(0, type === 'axe' ? -Math.PI / 2 : Math.PI / 2, Math.PI);
  const grip = new THREE.Vector3(0.02, spec.gripY, 0)
    .sub(new THREE.Vector3(...spec.strike)).multiplyScalar(spec.scale).applyEuler(rotation).applyEuler(rest);
  return handPosition.clone().sub(grip);
}

const triangleCounts = new Map();
export function countGamePropTriangles(type) {
  if (!triangleCounts.has(type)) {
    const model = createGameProp(type);
    triangleCounts.set(type, geometryStats(model).triangles);
    disposeModel(model);
  }
  return triangleCounts.get(type);
}

export function geometryStats(root) {
  let triangles = 0, draws = 0;
  root.traverse(object => {
    if (!object.isMesh) return;
    triangles += (object.geometry.index?.count ?? object.geometry.attributes.position.count) / 3;
    draws++;
  });
  return { triangles, draws };
}

export function disposeModel(root) {
  const geometries = new Set(), materials = new Set();
  root.traverse(object => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (material) materials.add(material);
    }
    object.skeleton?.dispose();
  });
  geometries.forEach(g => g.dispose());
  materials.forEach(m => m.dispose());
}
