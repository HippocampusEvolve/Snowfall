import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { Burst } from './burst.js';
import { buildShovel, afterFirstFrames } from './props/index.js';
import { snowTint } from './snowtint.js';
import { matsets, prepareMatsets } from './matsets.js';

// Лопата — инструмент копания (VISION.md: мир — это интерфейс, материя имеет
// вес и место). Живёт в мире воткнутой в снег; F — взять в руки, F — воткнуть
// там, где стоишь. В руках: ЛКМ — копнуть (срез-штык), ПКМ — уложить снег.
// Общий риг замахов и отдачи — tool.js; здесь только модель и кейфреймы.
// Копание — не рубка: ЛКМ гонит штык ТОЛЧКОМ вдоль оси (срез), дуга и сброс
// кистью принадлежат ПКМ (намыву). Оттого два разных набора кейфреймов.

const REST = new THREE.Euler(1.18, -0.12, -0.16); // покойный наклон в руках
const PIVOT_Y = 0.75; // где на черенке лежит нижняя кисть — центр вращения
// Остриё в покое, камерное пространство. Y подобран так, чтобы штык с тулейкой
// СТОЯЛИ В КАДРЕ у нижне-правого края: при y=-0.5 вся лопата в покое лежала
// ниже кромки 55°-frustum'а — «исчезала из рук» и появлялась только в замахе.
const TIP = new THREE.Vector3(0.3, -0.34, -0.55 * VIEW_Z);

// Раскладка тяжёлого инструмента: замах ~38% цикла, бросок ~8% (быстро!),
// hitstop ~60 мс, дальше рычаг и оседание. impact совпадает с концом броска —
// с точкой максимального выноса штыка и максимальной его скорости.
// px/py/pz — камерное смещение кистей; rx/ry/rz — поворот вокруг них.
// -rx гонит штык вниз-вперёд, +rx поднимает (см. REST).
const STROKES = {
  // срез-штык: отвели и подняли → толчок вниз-вперёд → рычаг, ком отрывается
  dig: {
    dur: 0.78,
    impact: 0.46,
    punch: { pitch: 1.7, roll: -0.55 },
    px: [[0, 0], [0.38, 0.04, 'io'], [0.46, -0.05, 'in'], [0.535, -0.05, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.2, 'in'], [0.535, -0.2, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.26, 'in'], [0.535, -0.26, 'hold'], [0.7, -0.1, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.38, 0.4, 'io'], [0.46, -0.34, 'in'], [0.535, -0.34, 'hold'], [0.7, 0.16, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.38, 0.1, 'io'], [0.46, -0.08, 'in'], [0.535, -0.08, 'hold'], [0.7, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.38, 0.12, 'io'], [0.46, -0.06, 'in'], [0.535, -0.06, 'hold'], [0.7, 0.02, 'out'], [1, 0, 'out']],
  },
  // намыв: подобрали снизу → вынос вперёд-вверх → сброс кистью
  build: {
    dur: 0.68,
    impact: 0.48,
    punch: { pitch: 0.7, roll: 0.25 },
    px: [[0, 0], [0.4, 0.02, 'io'], [0.48, -0.03, 'in'], [0.545, -0.03, 'hold'], [0.72, -0.01, 'out'], [1, 0, 'out']],
    py: [[0, 0], [0.4, -0.08, 'io'], [0.48, 0.16, 'in'], [0.545, 0.16, 'hold'], [0.72, 0.05, 'out'], [1, 0, 'out']],
    pz: [[0, 0], [0.4, 0.06, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
    rx: [[0, 0], [0.4, -0.1, 'io'], [0.48, 0.55, 'in'], [0.545, 0.55, 'hold'], [0.72, 0.2, 'out'], [1, 0, 'out']],
    ry: [[0, 0], [0.4, 0.04, 'io'], [0.48, -0.06, 'in'], [0.545, -0.06, 'hold'], [0.72, -0.02, 'out'], [1, 0, 'out']],
    rz: [[0, 0], [0.4, 0.05, 'io'], [0.48, -0.18, 'in'], [0.545, -0.18, 'hold'], [0.72, -0.05, 'out'], [1, 0, 'out']],
  },
};

// Модель собрана КОДОМ (src/props/shovel-geometry.js): черенок с Т-образной
// рукоятью, тулейка конусом, гранёный совок из трёх дощечек. Конвенция рига
// соблюдена самой геометрией - остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх
// по +Y, совок открыт в -Z, высота те же 1.45 м, - поэтому кейфреймы, PIVOT_Y
// и TIP выше остались нетронутыми.
//
// До этого лопата была моделью из Blender (shovel.glb, 56 КБ плюс общий
// Draco-декодер). Прежняя загрузка - в истории файла.

// Прототипов два, и это не расточительство. tool.js зовёт build() дважды:
// первый раз - для копии, что стоит воткнутой в снегу, второй - для копии в
// руках. Воткнутая обметена инеем (snowTint), та, что в руках, - нет: игрок
// её только что вынул и обтёр о рукав. Одним материалом на обе так не сделать.
const protos = { world: null, view: null };
const waiting = []; // группы, собранные до того, как наборы допеклись
let loading = null;
let built = 0; // первый build() - мир, второй - руки (порядок задан tool.js)

/** Печёт наборы и собирает обе лопаты один раз на весь мир. */
export function loadShovelModel() {
  if (!loading) {
    loading = prepareMatsets('iron', 'split').then(() => {
      const sets = matsets('iron', 'split');
      protos.world = buildShovel(sets);
      protos.view = buildShovel(sets);
      // воткнута в снег под открытым небом: иней на верхних гранях
      for (const name of ['steel', 'wood']) {
        snowTint(protos.world.getObjectByName(name).material, '0.78, 0.82, 0.9', 0.3, 0.5);
      }
      while (waiting.length) {
        const { group, which } = waiting.pop();
        group.add(protos[which].clone(true));
      }
      return protos.world;
    });
  }
  return loading;
}

// сборка лопаты: остриё штыка в НАЧАЛЕ КООРДИНАТ, черенок вверх по +Y
function buildShovelGroup() {
  const g = new THREE.Group();
  const which = built++ === 0 ? 'world' : 'view';
  // группа отдаётся сразу, а модель доедет в неё сама
  if (protos[which]) g.add(protos[which].clone(true));
  else waiting.push({ group: g, which });
  return g;
}

// Заказ отложен до первого нарисованного кадра: почему именно так - в
// props/index.js, у afterFirstFrames.
afterFirstFrames(loadShovelModel);

export class Shovel extends HeldTool {
  // scene — мир (воткнутая лопата и брызги), view — слой viewmodel (лопата в руках)
  constructor(scene, view) {
    super(scene, view, {
      build: buildShovelGroup,
      rest: REST,
      pivotY: PIVOT_Y,
      tip: TIP,
      strokes: STROKES,
      // воткнута остриём в снег, слегка наклонена
      plantPose(world, x, y, z, yaw) {
        world.position.set(x, y - 0.12, z);
        world.rotation.set(0.2, yaw, 0.07, 'YXZ');
      },
    });
    this.bursts = new Burst(scene); // снежная крошка из-под штыка
  }

  spray(point, dir) {
    this.bursts.spawn(point, dir);
  }

  update(dt, onImpact) {
    this.bursts.update(dt);
    super.update(dt, onImpact);
  }
}
