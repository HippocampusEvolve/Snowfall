import * as THREE from 'three';

const ray = new THREE.Raycaster();
const origin = new THREE.Vector3();
const direction = new THREE.Vector3();
const normalMatrix = new THREE.Matrix3();

// Transparent glazing is still a physical pane. Only visual fire effects
// should disappear from a hand's line of sight.
function solidMaterial(material) {
  return material && material.visible !== false
    && material.blending !== THREE.AdditiveBlending
    && !/^(flame|glow|spark)/i.test(material.name || '');
}

function nearestSolid(roots, maxDistance) {
  const meshes = [];
  for (const root of roots || []) {
    if (!root) continue;
    root.updateWorldMatrix(true, true);
    root.traverseVisible(object => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      if (materials.some(solidMaterial)) meshes.push(object);
    });
  }
  ray.near = 0;
  ray.far = maxDistance;
  const hits = ray.intersectObjects(meshes, false);
  return hits.find(hit => solidMaterial(Array.isArray(hit.object.material)
    ? hit.object.material[hit.face?.materialIndex ?? 0] : hit.object.material)) || null;
}

/** Can the hand reach a target through the supplied cabin/building geometry? */
export function visibility(camera, target, roots, tolerance = 0.25) {
  if (!target || ![target.x, target.y, target.z].every(Number.isFinite)) return false;
  camera.getWorldPosition(origin);
  direction.set(target.x, target.y, target.z).sub(origin);
  const distance = direction.length();
  const clearance = Math.max(0, Number.isFinite(tolerance) ? tolerance : 0.25);
  if (distance <= clearance) return true;
  direction.multiplyScalar(1 / distance);
  ray.set(origin, direction);
  return !nearestSolid(roots, distance - clearance);
}

/** Nearest physical cabin/structure surface in front of the camera. */
export function nearestStructureSurface(camera, roots, maxDistance = 3.2) {
  camera.getWorldPosition(origin);
  camera.getWorldDirection(direction);
  ray.set(origin, direction);
  const hit = nearestSolid(roots, maxDistance);
  if (!hit) return null;
  const normal = hit.face.normal.clone().applyNormalMatrix(normalMatrix.getNormalMatrix(hit.object.matrixWorld));
  // A double-sided glass pane may be hit from either side.
  if (normal.dot(direction) > 0) normal.negate();
  return { point: hit.point.clone(), normal, distance: hit.distance, object: hit.object };
}
