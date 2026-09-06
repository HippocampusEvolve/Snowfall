import test from 'node:test';
import assert from 'node:assert/strict';
import { createHearthState, HEARTH_FUEL_SECONDS, HEARTH_LOG_FUEL, HEARTH_INITIAL_FUEL } from '../src/hearth-state.js';

test('hearth has finite fuel and provides no heat after it burns out', () => {
  const hearth = createHearthState(1);
  hearth.age(HEARTH_FUEL_SECONDS / 2);
  assert.equal(hearth.fuel, 0.5);
  assert.ok(hearth.heatK > 0);
  hearth.age(HEARTH_FUEL_SECONDS);
  assert.equal(hearth.fuel, 0);
  assert.equal(hearth.heatK, 0);
  assert.equal(hearth.burning, false);
});

test('a log relights spent embers and fuel cannot exceed the hearth capacity', () => {
  const hearth = createHearthState(0);
  assert.equal(hearth.addFuel(), HEARTH_LOG_FUEL);
  assert.equal(hearth.burning, true);
  assert.ok(hearth.heatK > 0);
  hearth.addFuel(1);
  assert.equal(hearth.fuel, 1);
  assert.equal(hearth.addFuel(), 0);
});

test('paused visual updates do not consume fuel', () => {
  const hearth = createHearthState();
  hearth.update(HEARTH_FUEL_SECONDS, false);
  assert.equal(hearth.fuel, HEARTH_INITIAL_FUEL);
  hearth.update(HEARTH_FUEL_SECONDS, true);
  assert.equal(hearth.fuel, 0);
});

test('save restoration ages hearth independently through offline time', () => {
  const original = createHearthState(0.75);
  const restored = createHearthState(0);
  restored.restore(JSON.parse(JSON.stringify(original.snapshot())), { elapsedSeconds: HEARTH_FUEL_SECONDS / 4 });
  assert.equal(restored.fuel, 0.5);
  assert.equal(original.fuel, 0.75);
  restored.restore(original.snapshot(), { elapsedSeconds: HEARTH_FUEL_SECONDS * 10 });
  assert.equal(restored.heatK, 0);
});

test('legacy saves and malformed clock/fuel values stay finite', () => {
  const hearth = createHearthState();
  hearth.restore(undefined);
  assert.equal(hearth.fuel, HEARTH_INITIAL_FUEL);
  for (const elapsedSeconds of [-10, Infinity, NaN]) hearth.age(elapsedSeconds);
  assert.equal(hearth.fuel, HEARTH_INITIAL_FUEL);
  hearth.fuel = NaN;
  assert.equal(hearth.fuel, 0);
  for (const amount of [NaN, Infinity, -10]) assert.equal(hearth.addFuel(amount), 0);
  hearth.fuel = 42;
  assert.equal(hearth.fuel, 1);
});
