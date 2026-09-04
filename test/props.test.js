import test from 'node:test';
import assert from 'node:assert/strict';

import { countTriangles, countDrawCalls, boundsOf, finiteParts } from '../src/props/parts.js';
import { firepitParts } from '../src/props/firepit-geometry.js';
import { fireplaceParts } from '../src/props/fireplace-geometry.js';
import { shovelParts } from '../src/props/shovel-geometry.js';
import { potParts } from '../src/props/pot-geometry.js';
import { booksParts } from '../src/props/books-geometry.js';

// Предметы, собранные кодом, проверяются здесь ЦЕЛИКОМ и без three: список
// деталей - чистые числа, и по нему считаются и треугольники, и габарит.
//
// ГАБАРИТЫ ЗАШИТЫ ЧИСЛАМИ СТАРЫХ МОДЕЛЕЙ. Это не украшение теста: кострище,
// камин, лопата, котелок и стопка книг заменили файлы .glb и .gltf, и вокруг
// каждого уже выставлен мир - просвет кладки под пламя, полость топки под
// футеровку, кейфреймы лопаты в руках, коллайдеры и посадка на столешницу.
// Предмет, уехавший по размеру, ломает всё это молча. Пять процентов - тот
// допуск, внутри которого мир остаётся настроенным.
//
// Числа сняты обмером самих файлов до их удаления: у glTF минимум и максимум
// POSITION лежат в самом описании, поэтому мерить можно было, не распаковывая
// Draco.
const OLD = {
  firepit: [1.2185, 0.2271, 1.2433],
  fireplace: [2.32, 4.25, 1.18],
  shovel: [0.2, 1.45, 0.0655],
  pot: [0.3019, 0.2909, 0.3017],
  books: [0.5513, 0.2374, 0.1631],
};

// [имя, сборка, бюджет треугольников]
const PROPS = [
  ['firepit', firepitParts, 900],
  ['fireplace', fireplaceParts, 1200],
  ['shovel', shovelParts, 400],
  ['pot', potParts, 400],
  ['books', booksParts, 600],
];

const AXES = ['ширина', 'высота', 'глубина'];

for (const [name, parts, budget] of PROPS) {
  test(`${name}: бюджет треугольников и draw call'ов`, () => {
    const p = parts();
    const t = countTriangles(p);
    const d = countDrawCalls(p);
    console.log(`      ${name}: ${t} треугольников, ${d} draw call`);
    assert.ok(t <= budget, `${name}: ${t} треугольников при бюджете ${budget}`);
    assert.ok(d <= 2, `${name}: ${d} draw call, а разрешено два`);
  });

  test(`${name}: ни одного NaN в описании`, () => {
    const bad = finiteParts(parts());
    assert.deepEqual(bad, [], `${name}: не-числа в ${bad.join(', ')}`);
  });

  test(`${name}: сборка детерминирована`, () => {
    // Два вызова подряд обязаны дать одно и то же: раскладка предметов зашита
    // числами, а не случайностью, иначе мир менялся бы от захода к заходу и
    // проверка мерила бы одно, а игрок видел другое.
    assert.deepEqual(JSON.parse(JSON.stringify(parts())), JSON.parse(JSON.stringify(parts())));
  });

  test(`${name}: габарит в пределах 5% от прежней модели`, () => {
    const { size } = boundsOf(parts());
    OLD[name].forEach((want, i) => {
      const dev = (size[i] / want - 1) * 100;
      console.log(`      ${name}, ${AXES[i]}: ${size[i].toFixed(4)} против ${want} (${dev.toFixed(1)}%)`);
      assert.ok(
        Math.abs(dev) <= 5,
        `${name}, ${AXES[i]}: ${size[i].toFixed(4)} против ${want} - отклонение ${dev.toFixed(1)}%`
      );
    });
  });
}

test('лопата: остриё штыка в начале координат, черенок вверх', () => {
  // Конвенция рига HeldTool. Кейфреймы замахов, точка хвата и остриё в покое
  // (shovel.js) отсчитываются от неё, и сдвиг геометрии их не заметит.
  const { min, max } = boundsOf(shovelParts());
  assert.ok(Math.abs(min[1]) < 1e-6, `низ лопаты на ${min[1]}, а должен быть на нуле`);
  assert.ok(Math.abs(max[1] - 1.45) < 1e-6, `верх лопаты на ${max[1]}, а должен быть на 1.45`);
  assert.ok(Math.abs(min[0] + max[0]) < 1e-6, 'лопата не симметрична по ширине');
  // совок открыт в -Z: штык уходит назад дальше, чем вперёд
  assert.ok(-min[2] > max[2], 'совок открыт не в -Z');
});

test('камин: полость топки свободна от кладки', () => {
  // Нутро топки (firebox.js) стоит в полости, обмеренной по камину. Здесь
  // проверяется обратное: сама кладка в эту полость не залезла. Подробный
  // обмер лучами - tools/firebox-check.mjs, тут грубая рамка на каждый прогон.
  const CAVITY = { back: 0.115, floor: 0.16, roof: 1.1, mouth: 0.6, side: 0.47 };
  fireplaceParts().forEach((p, i) => {
    const b = boundsOf([p]);
    const inside =
      b.min[0] < CAVITY.side - 1e-9 && b.max[0] > -CAVITY.side + 1e-9 &&
      b.min[1] < CAVITY.roof - 1e-9 && b.max[1] > CAVITY.floor + 1e-9 &&
      b.min[2] < CAVITY.mouth - 1e-9 && b.max[2] > CAVITY.back + 1e-9;
    assert.ok(!inside, `деталь ${p.role} #${i} в ${b.min} .. ${b.max} залезла в полость топки`);
  });
});

test('стопка книг стоит на столешнице, а не в ней', () => {
  const { min } = boundsOf(booksParts());
  assert.ok(min[1] >= -1e-9, `низ стопки на ${min[1]}, то есть под столом`);
});

test('котелок стоит донцем на нуле', () => {
  const { min } = boundsOf(potParts());
  assert.ok(Math.abs(min[1]) < 1e-9, `донце на ${min[1]}`);
});
