import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal, KIND } from '../src/journal.js';
import { Inventory } from '../src/inventory.js';
import { RECIPES } from '../src/data/recipes.js';
import { MATERIAL } from '../src/caves.js';
import { applyRecipe, buildRecipeFor } from '../src/building.js';

class FakeDigger {
  constructor() {
    this.calls = [];
    this.materials = new Map();
  }

  buildStroke(center, radius, strength, material) {
    this.calls.push({ center: { ...center }, radius, strength, material });
    this.materials.set(`${center.x}|${center.y}|${center.z}`, material);
    if (this.onStroke) this.onStroke(center, 0, 1, strength, material, 'hand');
  }

  materialAt(x, y, z) {
    return this.materials.get(`${x}|${y}|${z}`);
  }
}

test('первым выбирается доступный камень, затем грунт и снег', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  inventory.add('snow', 1);
  inventory.add('soil', 1);
  assert.equal(buildRecipeFor(inventory).id, 'pour-soil');
  inventory.add('stone', 1);
  assert.equal(buildRecipeFor(inventory).id, 'place-stone');
});

test('рецепт списывает один предмет и передаёт вокселю его материал', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  const digger = new FakeDigger();
  const center = { x: 8, y: 1.5, z: -4 };
  const recipe = RECIPES.find((entry) => entry.id === 'place-stone');
  inventory.add('stone', 2);

  assert.equal(applyRecipe(recipe, inventory, digger, center), true);
  assert.equal(inventory.count('stone'), 1);
  assert.equal(digger.materialAt(center.x, center.y, center.z), MATERIAL.STONE);
  assert.deepEqual(
    [digger.calls[0].radius, digger.calls[0].strength, digger.calls[0].material],
    [recipe.give.radius, recipe.give.strength, MATERIAL.STONE]
  );
  const last = journal.at(journal.count - 1);
  assert.deepEqual([last.kind, last.id, last.delta], [KIND.ITEM, 2, -1]);
});

test('стройка внутри avoid не меняет ни мир, ни инвентарь', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  const digger = new FakeDigger();
  const recipe = RECIPES[0];
  inventory.add('stone', 1);
  const before = journal.count;

  assert.equal(
    applyRecipe(recipe, inventory, digger, { x: 1, y: 0, z: 2 }, [{ x: 0, z: 0, r: 4 }]),
    false
  );
  assert.equal(inventory.count('stone'), 1);
  assert.equal(journal.count, before);
  assert.equal(digger.calls.length, 0);
});

test('успешная стройка оставляет DIG с материалом и ITEM минус один', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  const digger = new FakeDigger();
  digger.onStroke = (center, yaw, sign, strength, material, tool) => {
    journal.dig(center.x, center.y, center.z, yaw, sign, strength, 7, material, tool);
  };
  inventory.add('stone', 1);

  assert.equal(applyRecipe(RECIPES[0], inventory, digger, { x: 5, y: 2, z: 6 }), true);
  const records = [...journal.records()].slice(-2);
  assert.deepEqual(
    [records[0].kind, records[0].sign, records[0].material, records[0].tool],
    [KIND.DIG, 1, MATERIAL.STONE, 'hand']
  );
  assert.deepEqual([records[1].kind, records[1].delta], [KIND.ITEM, -1]);
});
