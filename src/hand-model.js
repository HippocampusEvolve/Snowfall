import * as THREE from 'three';

/** A wool-lined work mitten closes around the real shaft. Only the held copy
 * gets a hand; tools laid on the bench never leave a disembodied glove there. */
export function attachToolGrip(tool) {
  const carried = tool.swing.children[0];
  // HeldTool supports a straight shaft through (0,pivotY,0). Lab heads have
  // offset working points and bent handles. Move its pivot onto this shaft
  // while keeping the model's existing rest-space working point unchanged.
  const tip = tool.holder.position.clone().add(carried.position);
  const shaft = carried.userData.grip.clone().applyEuler(carried.rotation);
  carried.position.copy(shaft).negate();
  tool.holder.position.copy(tip).add(shaft);
  tool._aspectRestX = tool.holder.position.x;
  carried.updateMatrix();
  const grip = carried.userData.grip.clone().applyMatrix4(carried.matrix);
  const root = new THREE.Group();
  root.name = 'Right mitten gripping handle';
  root.position.copy(grip);
  const leather = new THREE.MeshStandardMaterial({ color: 0x564d42, roughness: 0.94 });
  const cuff = new THREE.MeshStandardMaterial({ color: 0x9e9b89, roughness: 1 });
  const wool = new THREE.MeshStandardMaterial({ color: 0x39464a, roughness: 1 });
  const part = (name, scale, position, material) => {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), material);
    mesh.name = name; mesh.scale.fromArray(scale); mesh.position.fromArray(position); root.add(mesh);
    return mesh;
  };
  part('Closed mitten', [0.068, 0.065, 0.047], [0.035, -0.002, 0.028], leather).rotation.z = -0.3;
  part('Thumb around shaft', [0.032, 0.05, 0.027], [-0.026, 0.018, 0.029], leather).rotation.z = -0.65;
  // One continuous arm axis, with overlap at both seams. Rotating separate
  // ellipsoids the other way made the sleeve point away from the wrist.
  const tube = (name, from, to, bottomRadius, topRadius, material) => {
    const start = new THREE.Vector3(...from), end = new THREE.Vector3(...to);
    const axis = end.clone().sub(start);
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(topRadius, bottomRadius, axis.length(), 14), material);
    mesh.name = name;
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    root.add(mesh);
    return mesh;
  };
  tube('Coat sleeve', [0.19, -0.40, 0.11], [0.074, -0.083, 0.047], 0.084, 0.055, wool);
  tube('Wool cuff', [0.089, -0.12, 0.058], [0.063, -0.056, 0.043], 0.061, 0.052, cuff);
  tube('Mitten wrist', [0.066, -0.078, 0.045], [0.045, -0.031, 0.032], 0.047, 0.048, leather);
  tool.swing.add(root);
  // This belongs to the isolated viewmodel hierarchy and is hidden along with
  // its tool. A little bounced skylight keeps an unlit handle readable without
  // lighting any part of the world or changing the shared moon key.
  const fill = new THREE.HemisphereLight(0xb5c7dc, 0x727b83, 0.65);
  fill.name = 'Tool bounced skylight';
  tool.holder.add(fill);
  tool.grip = root;
  return root;
}

/** Fit a carried tool horizontally to the 55-degree viewmodel camera. Keep
 * the contact frame anchored to the established aiming pose, then ease back
 * to the narrow-screen rest position during recovery. Also works for the
 * shovel's original rig, which does not call attachToolGrip. */
export function fitToolToAspect(tool, aspect) {
  if (!tool?.holder) return;
  if (!Number.isFinite(tool._aspectRestX)) tool._aspectRestX = tool.holder.position.x;
  const width = Number.isFinite(aspect) && aspect > 0 ? aspect : 1.5;
  const factor = Math.min(1, width / 1.5);
  const wristMargin = 0.035 * Math.max(0, 1 - width / 1.2);
  let contact = 0;
  const stroke = tool.strokes?.[tool.kind];
  if (tool.swingT >= 0 && stroke && tool.dur > 0) {
    const u = tool.swingT / tool.dur;
    const ease = x => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * (3 - 2 * t); };
    const impact = stroke.impact;
    contact = u <= impact ? ease(u / impact)
      : 1 - ease((u - impact) / (1 - impact));
  }
  const restOffset = tool._aspectRestX * (factor - 1) - wristMargin;
  tool.holder.position.x = tool._aspectRestX + restOffset * (1 - contact);
}
