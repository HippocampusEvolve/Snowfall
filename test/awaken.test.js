import test from 'node:test';
import assert from 'node:assert/strict';

import { createAwakening } from '../src/awaken.js';

/** Мир-заглушка: запоминает, что пробуждение сделало с туманом, светом и взглядом. */
function world(ready = () => true) {
  const state = { fog: null, light: null, sound: null, yaw: null, pitch: null };
  const look = {
    yaw: 0.8,
    setYaw(yaw, pitch) {
      state.yaw = yaw;
      state.pitch = pitch;
    },
  };
  const awakening = createAwakening({
    setFog: (v) => { state.fog = v; },
    setLight: (v) => { state.light = v; },
    setSound: (v) => { state.sound = v; },
    look,
    yaw: look.yaw,
    ready,
  });
  /** Прокрутить n секунд кадрами по 1/60, как это делает цикл мира. */
  const run = (seconds) => {
    for (let t = 0; t < seconds; t += 1 / 60) awakening.update(1 / 60);
  };
  return { awakening, state, run, look };
}

test('нажатие принимается из любой фазы, а не только из готовой', () => {
  // Из темноты: мир ещё не показал ни кадра.
  const dark = world();
  assert.equal(dark.awakening.enter(), true);

  // Посреди проявления: раньше нажатие тут пропадало молча, и мир оставался
  // тёмным навсегда - ровно то, что снаружи читалось как зависание.
  const mid = world();
  mid.awakening.reveal();
  mid.run(0.5);
  assert.equal(mid.awakening.enter(), true);

  // Проявление закончилось - обычный случай.
  const veiled = world();
  veiled.awakening.reveal();
  veiled.run(2);
  assert.equal(veiled.awakening.enter(), true);
});

test('повторное нажатие пробуждение не перезапускает', () => {
  const w = world();
  w.awakening.reveal();
  w.run(2);
  assert.equal(w.awakening.enter(), true);
  w.run(1);
  assert.equal(w.awakening.enter(), false, 'второе нажатие не должно ронять подъём в начало');
});

test('вход посреди проявления не рвёт картинку', () => {
  const w = world();
  w.awakening.reveal();
  w.run(0.5);
  const fogBefore = w.state.fog;
  const lightBefore = w.state.light;

  w.awakening.enter();
  w.awakening.update(1 / 60);

  // Первый кадр пробуждения продолжает то, что было на экране, а не прыгает к
  // табличной ступени: пелена не может стать заметно плотнее или реже за кадр.
  assert.ok(Math.abs(w.state.fog - fogBefore) < 0.15, `туман дёрнулся: ${fogBefore} -> ${w.state.fog}`);
  assert.ok(Math.abs(w.state.light - lightBefore) < 0.05, `свет дёрнулся: ${lightBefore} -> ${w.state.light}`);
});

test('подъём взгляда всегда доходит до конца, откуда бы ни начался', () => {
  for (const wait of [0, 0.3, 1.4, 3]) {
    const w = world();
    w.awakening.reveal();
    w.run(wait);
    w.awakening.enter();
    w.run(3.5); // WAKE_MS с запасом

    assert.equal(w.awakening.holds(), false, `ожидание ${wait} с: мир не отдал управление`);
    assert.ok(Math.abs(w.state.pitch) < 1e-9, `ожидание ${wait} с: взгляд не поднялся до конца`);
    assert.ok(Math.abs(w.state.yaw - w.look.yaw) < 1e-9, `ожидание ${wait} с: взгляд не довёрнут`);
    assert.equal(w.state.fog, 1, `ожидание ${wait} с: пелена не отошла`);
    assert.equal(w.state.light, 1, `ожидание ${wait} с: свет не набрал силу`);
  }
});

test('в недособранный мир управление не отдаётся', () => {
  let built = false;
  const w = world(() => built);
  w.awakening.reveal();
  w.run(2);
  w.awakening.enter();
  w.run(4);

  assert.equal(w.awakening.holds(), true, 'мир не готов, а управление уже отдано');
  built = true;
  w.run(0.1);
  assert.equal(w.awakening.holds(), false, 'мир готов, а управление так и не отдано');
});
