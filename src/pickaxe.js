import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { Burst } from './burst.js';
import { createGameProp, labToolTip } from './props/lab/tools.js';
import { attachToolGrip } from './hand-model.js';

export { countPickaxeTriangles } from './pickaxe-geometry.js';

// Кирка живёт на том же риге, что лопата и топор. Рабочая точка модели -
// левое остриё в начале координат, рукоять идёт вверх по +Y.
const REST = new THREE.Euler(-0.24, 0.18, Math.PI + 0.08);
const PIVOT_Y = 0.64;
const TIP = labToolTip('pickaxe', REST, new THREE.Vector3(0.27, -0.27, -0.7 * VIEW_Z));

const STROKES = {
  mine: {
    dur: 0.76,
    impact: 0.46,
    punch: { pitch: 1.35, roll: 0.68 },
    px: [[0, 0], [0.37, 0.13, 'io'], [0.46, 0.03, 'in'], [0.54, 0.03, 'hold'], [0.72, -0.04, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.37, 0.2, 'io'], [0.46, 0.38, 'in'], [0.54, 0.38, 'hold'], [0.72, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.37, 0.13, 'io'], [0.46, -0.34, 'in'], [0.54, -0.34, 'hold'], [0.72, -0.09, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.37, 0.7, 'io'], [0.46, -0.78, 'in'], [0.54, -0.78, 'hold'], [0.72, 0.16, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.3, 'io'], [0.46, 0.28, 'in'], [0.54, 0.28, 'hold'], [0.72, 0.05, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, -0.32, 'io'], [0.46, 0.3, 'in'], [0.54, 0.3, 'hold'], [0.72, 0.06, 'out'], [1, 0, 'out']],
  },
};

function buildPickaxe() {
  return createGameProp('pickaxe');
}

export class Pickaxe extends HeldTool {
  constructor(scene, view) {
    super(scene, view, {
      build: buildPickaxe,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y + 0.02, z);
        world.rotation.set(-0.58, yaw, 0.12, 'YXZ');
      },
    });
    attachToolGrip(this);
    this.chips = new Burst(scene, {
      color: '0.38, 0.34, 0.30',
      size: 27,
      gravity: 14,
      drag: 2.4,
      max: 130,
    });
  }

  spray(point, dir) {
    this.chips.spawn(point, dir, 12);
  }

  update(dt, onImpact) {
    this.chips.update(dt);
    super.update(dt, onImpact);
  }
}
