import test from 'node:test';
import assert from 'node:assert/strict';

import {
  regrowStage, regrowScale, healedHits, fuelAfter, trailFade, pitFill,
  REGROW_YOUNG, REGROW_GROWN, REGROW_ADULT, HEAL_HITS, FUEL_TIME_AWAY,
  TRAIL_TAU, PIT_TAU,
} from '../src/growth.js';

test('сразу после сруба на месте сосны пень', () => {
  assert.equal(regrowStage(REGROW_YOUNG - 1), 'stump');
});

test('через два часа из пня идёт молодняк', () => {
  assert.equal(regrowStage(REGROW_YOUNG), 'young');
});

test('через сутки молодняк подрастает', () => {
  assert.equal(regrowStage(REGROW_GROWN), 'grown');
});

test('через трое суток сосна снова взрослая', () => {
  assert.equal(regrowStage(REGROW_ADULT), 'adult');
});

test('стадии растут в масштабе', () => {
  assert.deepEqual(
    ['stump', 'young', 'grown', 'adult'].map(regrowScale),
    [0, 0.35, 0.7, 1]
  );
});

test('зарубки зарастают за сутки в ноль', () => {
  assert.equal(healedHits(7, HEAL_HITS), 0);
});

test('за половину суток зарубок остаётся половина', () => {
  assert.equal(healedHits(6, HEAL_HITS / 2), 3);
});

test('костёр за два часа прогорает до углей', () => {
  assert.equal(fuelAfter(1, FUEL_TIME_AWAY), 0);
});

test('топливо ниже нуля не уходит', () => {
  assert.equal(fuelAfter(0.2, FUEL_TIME_AWAY * 10), 0);
});

test('короткая отлучка съедает топливо пропорционально', () => {
  assert.equal(fuelAfter(1, FUEL_TIME_AWAY / 4), 0.75);
});

test('без отлучки тропы не бледнеют', () => {
  assert.equal(trailFade(0), 1);
});

test('за постоянную затухания от троп остаётся треть', () => {
  assert.ok(Math.abs(trailFade(TRAIL_TAU) - Math.exp(-1)) < 1e-12);
});

test('за бесконечность троп не остаётся', () => {
  assert.equal(trailFade(Infinity), 0);
});

test('без отлучки ямы не затягивает', () => {
  assert.equal(pitFill(0), 1);
});

test('за трое суток яма затягивается на две трети', () => {
  assert.ok(Math.abs(pitFill(PIT_TAU) - Math.exp(-1)) < 1e-12);
});

test('за бесконечность от ямы не остаётся ничего', () => {
  assert.equal(pitFill(Infinity), 0);
});
