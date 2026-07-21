import * as THREE from 'three';
import { VIEW_Z } from './viewmodel.js';
import { HeldTool } from './tool.js';
import { Burst } from './burst.js';

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
const PIVOT_Y = 0.52; // нижняя кисть на середине топорища — центр вращения
// Голова в покое — справа, чуть ниже середины кадра; топорище уходит вниз,
// к нижне-правому углу (кисти за кадром). Кромка смотрит вперёд, на прицел.
const TIP = new THREE.Vector3(0.34, -0.17, -0.5 * VIEW_Z);

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
    px: [[0, 0], [0.37, 0.14, 'io'], [0.45, -0.14, 'in'], [0.525, -0.14, 'hold'], [0.7, -0.05, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.37, 0.18, 'io'], [0.45, -0.16, 'in'], [0.525, -0.16, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.37, 0.12, 'io'], [0.45, -0.36, 'in'], [0.525, -0.36, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.37, 0.66, 'io'], [0.45, -0.72, 'in'], [0.525, -0.72, 'hold'], [0.7, 0.14, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.36, 'io'], [0.45, 0.32, 'in'], [0.525, 0.32, 'hold'], [0.7, 0.06, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, -0.4, 'io'], [0.45, 0.38, 'in'], [0.525, 0.38, 'hold'], [0.7, 0.08, 'out'], [1, 0, 'out']],
  },
};

// сборка топора: КРОМКА ЛЕЗВИЯ в начале координат, топорище вверх по +Y —
// та же конвенция, что у лопаты (рабочая точка = origin), потому воткнутый
// топор стоит на голове, рукоятью вверх, как и положено в колоде
function buildAxe() {
  const g = new THREE.Group();
  // metalness умеренный: в сцене нет env-карты, чистый металл в полярной ночи
  // отражал бы пустоту и чернел — сталь читается по бликам ключа и полусферы
  const steel = new THREE.MeshStandardMaterial({ color: 0x8792a0, metalness: 0.55, roughness: 0.42 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a6238, roughness: 0.8 });

  // голова: профиль (вперёд = кромка с бородой, назад = обух) выдавлен в
  // толщину. Борода — со стороны РУКОЯТИ (рукоять в модели уходит вверх,
  // значит борода — верхний зуб кромки): в руках, головой вверх, она свисает
  // к кистям, как у настоящего топора
  const s = new THREE.Shape();
  s.moveTo(0, 0.155); // верх кромки — борода чуть свисает к топорищу
  s.lineTo(0, -0.035); // кромка — почти вертикальная линия
  s.quadraticCurveTo(0.07, -0.025, 0.12, 0.0); // нижняя щека к всаду
  s.lineTo(0.175, 0.005); // обух
  s.lineTo(0.175, 0.075);
  s.quadraticCurveTo(0.08, 0.09, 0.045, 0.125); // верхняя щека, подрез к бороде
  s.closePath();
  const headGeo = new THREE.ExtrudeGeometry(s, {
    depth: 0.03,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.007,
    bevelSegments: 2,
  });
  headGeo.translate(0, 0, -0.015); // толщина симметрично
  headGeo.rotateY(-Math.PI / 2); // профиль x → мировой z: кромка на z=0, обух сзади
  const head = new THREE.Mesh(headGeo, steel);
  head.castShadow = true;
  g.add(head);

  // топорище: сквозь всад вверх, лёгкий наклон вперёд к голове
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.023, 0.78, 8), wood);
  shaft.position.set(0, 0.45, 0.152);
  shaft.rotation.x = 0.06;
  shaft.castShadow = true;
  g.add(shaft);

  // хвост рукояти — утолщение, чтобы кисть не соскальзывала
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.021, 0.07, 8), wood);
  knob.position.set(0, 0.85, 0.128);
  knob.rotation.x = 0.06;
  knob.castShadow = true;
  g.add(knob);

  return g;
}

export class Axe extends HeldTool {
  // scene — мир (воткнутый топор, щепа), view — слой viewmodel (топор в руках)
  constructor(scene, view) {
    super(scene, view, {
      build: buildAxe,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      // воткнут лезвием в колоду/наст, топорище вверх-назад под углом
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y + 0.015, z);
        world.rotation.set(-0.72, yaw, 0.1, 'YXZ');
      },
    });
    // щепа — тяжелее и темнее снежной крошки, летит скупее
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
