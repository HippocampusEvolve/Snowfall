import * as THREE from 'three';
import { VIEW_Z } from './viewmodel.js';
import { HeldTool } from './tool.js';
import { Burst } from './burst.js';

// Топор — инструмент рубки (VISION.md, «память рук»: топор → рубка → кучи).
// Живёт в мире воткнутым в колоду у поленницы — хозяйство стояло тут до
// игрока. F — взять, F — воткнуть там, где стоишь. В руках: ЛКМ — удар.
// Один и тот же замах рубит стоящую сосну и разделывает лежащий ствол —
// что именно случилось, решает lumber.js в момент врезания.

const REST = new THREE.Euler(1.02, -0.22, -0.14); // покойный наклон: обух у плеча
const PIVOT_Y = 0.52; // нижняя кисть на середине топорища — центр вращения
// Лезвие в покое — у нижне-правого края кадра (подбор как у лопаты: выше —
// лезет в кадр, ниже — исчезает из рук)
const TIP = new THREE.Vector3(0.32, -0.30, -0.5 * VIEW_Z);

// Рубка — диагональный секущий мах: занос обуха за плечо вверх-вправо →
// быстрый косой бросок вниз-влево-вперёд → hitstop в древесине →
// выдёргивание лезвия и оседание. cross (tool.js) чередует диагональ —
// удары ложатся крест-накрест, как при настоящей валке.
const STROKES = {
  chop: {
    dur: 0.72,
    impact: 0.45,
    punch: { pitch: 1.15, roll: 0.85 },
    px: [[0, 0], [0.37, 0.15, 'io'], [0.45, -0.12, 'in'], [0.525, -0.12, 'hold'], [0.7, -0.03, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.37, 0.2, 'io'], [0.45, -0.17, 'in'], [0.525, -0.17, 'hold'], [0.7, 0.0, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.37, 0.11, 'io'], [0.45, -0.3, 'in'], [0.525, -0.3, 'hold'], [0.7, -0.08, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.37, 0.55, 'io'], [0.45, -0.48, 'in'], [0.525, -0.48, 'hold'], [0.7, 0.12, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.37, -0.3, 'io'], [0.45, 0.26, 'in'], [0.525, 0.26, 'hold'], [0.7, 0.05, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.37, 0.28, 'io'], [0.45, -0.3, 'in'], [0.525, -0.3, 'hold'], [0.7, -0.06, 'out'], [1, 0, 'out']],
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

  // голова: профиль (вперёд = кромка с бородой, назад = обух) выдавлен в толщину
  const s = new THREE.Shape();
  s.moveTo(0, -0.035); // низ кромки — борода чуть свисает
  s.lineTo(0, 0.155); // кромка — почти вертикальная линия
  s.quadraticCurveTo(0.07, 0.145, 0.12, 0.12); // верхняя щека к всаду
  s.lineTo(0.175, 0.115); // обух
  s.lineTo(0.175, 0.045);
  s.quadraticCurveTo(0.08, 0.03, 0.045, -0.005); // нижняя щека, подрез к бороде
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
