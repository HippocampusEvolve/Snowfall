import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { Burst } from './burst.js';
import { createGameProp, labToolTip } from './props/lab/tools.js';
import { attachToolGrip } from './hand-model.js';

// Топор — инструмент рубки (VISION.md, «память рук»: топор → рубка → кучи).
// Живёт в мире воткнутым в колоду у поленницы — хозяйство стояло тут до
// игрока. F — взять, F — воткнуть там, где стоишь. В руках: ЛКМ — удар.
// Один и тот же замах рубит стоящую сосну и разделывает лежащий ствол —
// что именно случилось, решает lumber.js в момент врезания.

// Топор в руках несут ГОЛОВОЙ ВВЕРХ, кромкой вперёд — не как лопату остриём
// вниз. Модель построена рабочей точкой вниз (конвенция рига), поэтому покой —
// это переворот: rz≈π ставит голову над кистями (топорище вниз, к рукам),
// ry доворачивает кромку к прицелу, rx чуть роняет голову вперёд от лица.
const REST = new THREE.Euler(-0.2, 0.3, Math.PI + 0.15);
const PIVOT_Y = 0.52; // attachToolGrip уточняет пивот по изогнутой рукояти lab.
// Лабораторная кромка направлена вперёд; рука в варежке видна ниже головы.
const TIP = labToolTip('axe', REST, new THREE.Vector3(0.27, -0.27, -0.7 * VIEW_Z));

// Рубка — диагональный секущий мах: занос головы за правое плечо (топор почти
// покидает кадр — замах живёт за спиной) → косой бросок сверху-справа
// вниз-влево-вперёд, кромка ведёт и в кадре контакта ложится под прицел →
// hitstop в древесине → выдёргивание лезвия и оседание. cross (tool.js)
// чередует диагональ — удары ложатся крест-накрест, как при настоящей валке.
// Знаки поворотов — для головы НАД пивотом: +rx запрокидывает её за плечо,
// -rx хлещет вперёд-вниз; -rz кренит занос вправо, +rz проносит голову влево.
const STROKES = {
  chop: {
    dur: 0.72,
    impact: 0.45,
    punch: { pitch: 1.15, roll: 0.85 },
    px: [[0, 0], [0.37, 0.14, 'io'], [0.45, 0.13, 'in'], [0.525, 0.13, 'hold'], [0.7, -0.05, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.37, 0.18, 'io'], [0.45, 0.27, 'in'], [0.525, 0.27, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.37, 0.12, 'io'], [0.45, -0.36, 'in'], [0.525, -0.36, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.37, 0.66, 'io'], [0.45, -0.72, 'in'], [0.525, -0.72, 'hold'], [0.7, 0.14, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.36, 'io'], [0.45, 0.32, 'in'], [0.525, 0.32, 'hold'], [0.7, 0.06, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, -0.4, 'io'], [0.45, 0.38, 'in'], [0.525, 0.38, 'hold'], [0.7, 0.08, 'out'], [1, 0, 'out']],
  },
};

function buildAxe() {
  return createGameProp('axe');
}

export class Axe extends HeldTool {
  // scene — мир (воткнутый топор, щепа), view — слой viewmodel (топор в руках)
  constructor(scene, view) {
    super(scene, view, {
      build: buildAxe,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: { ...STROKES, timber: STROKES.chop },
      // воткнут лезвием в колоду/наст, топорище вверх-назад под углом
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y + 0.015, z);
        world.rotation.set(-0.72, yaw, 0.1, 'YXZ');
      },
    });
    // щепа — тяжелее и темнее снежной крошки, летит скупее
    attachToolGrip(this);
    this.chips = new Burst(scene, {
      color: '0.42, 0.30, 0.18',
      size: 30.0,
      gravity: 13,
      drag: 2.2,
      max: 140,
    });
    // сбитый с веток/коры снежок — идёт вместе со щепой при ударе по стволу
    this.dust = new Burst(scene, { size: 44.0, gravity: 5.5, max: 160 });
  }

  // щепа + облачко снега из зарубки
  spray(point, dir) {
    this.chips.spawn(point, dir, 14);
    this.dust.spawn(point, dir, 10);
  }

  update(dt, onImpact) {
    this.chips.update(dt);
    this.dust.update(dt);
    super.update(dt, onImpact);
  }
}
