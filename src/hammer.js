import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { Burst } from './burst.js';
import { createGameProp, labToolTip } from './props/lab/tools.js';
import { attachToolGrip } from './hand-model.js';

export { countHammerTriangles } from './hammer-geometry.js';

const REST = new THREE.Euler(-0.22, 0.2, Math.PI + 0.1);
const PIVOT_Y = 0.58;
const TIP = labToolTip('hammer', REST, new THREE.Vector3(0.27, -0.27, -0.7 * VIEW_Z));

const STROKES = {
  mine: {
    dur: 0.82,
    impact: 0.48,
    punch: { pitch: 0.9, roll: 0.5 },
    px: [[0, 0], [0.39, 0.1, 'io'], [0.48, -0.02, 'in'], [0.56, -0.02, 'hold'], [0.74, -0.03, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.39, 0.2, 'io'], [0.48, 0.19, 'in'], [0.56, 0.19, 'hold'], [0.74, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.39, 0.12, 'io'], [0.48, -0.31, 'in'], [0.56, -0.31, 'hold'], [0.74, -0.08, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.39, 0.72, 'io'], [0.48, -0.7, 'in'], [0.56, -0.7, 'hold'], [0.74, 0.14, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.39, -0.25, 'io'], [0.48, 0.22, 'in'], [0.56, 0.22, 'hold'], [1, 0, 'out']],
    rz: [[0, 0], [0.39, -0.25, 'io'], [0.48, 0.26, 'in'], [0.56, 0.26, 'hold'], [1, 0, 'out']],
  },
};

function buildHammer() {
  return createGameProp('hammer');
}

export class Hammer extends HeldTool {
  constructor(scene, view) {
    super(scene, view, {
      build: buildHammer,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y + 0.055, z);
        world.rotation.set(0.08, yaw, 1.42, 'YXZ');
      },
    });
    attachToolGrip(this);
    this.chips = new Burst(scene, {
      color: '0.38, 0.34, 0.30', size: 25, gravity: 14, drag: 2.4, max: 100,
    });
  }

  spray(point, dir) {
    this.chips.spawn(point, dir, 8);
  }

  update(dt, onImpact) {
    this.chips.update(dt);
    super.update(dt, onImpact);
  }
}
