import test from 'node:test';
import assert from 'node:assert/strict';

import { Journal, KIND } from '../src/journal.js';
import { Inventory } from '../src/inventory.js';
import { ITEM_INDEX } from '../src/data/items.js';
import { applyRecipeAt, recipeAt } from '../src/crafting.js';

test('рецепт крафта доступен только у своей станции', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  inventory.add('log', 1);
  const recipe = recipeAt(inventory, 'craft', 'workbench');
  const before = journal.count;

  assert.equal(recipe.id, 'make-torch');
  assert.equal(recipeAt(inventory, 'craft', 'anvil'), null);
  assert.equal(applyRecipeAt(recipe, inventory, 'anvil'), false);
  assert.equal(journal.count, before);
});

test('верстак списывает ровно take и добавляет ровно give', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  inventory.add('log', 1);
  inventory.add('soil', 1);
  const recipe = recipeAt(inventory, 'craft', 'workbench');
  const before = journal.count;

  assert.equal(applyRecipeAt(recipe, inventory, 'workbench'), true);
  assert.deepEqual(
    [inventory.count('log'), inventory.count('soil'), inventory.count('torch')],
    [0, 1, 2]
  );
  assert.deepEqual(
    [...journal.records()].slice(before).map((r) => [r.kind, r.id, r.delta]),
    [
      [KIND.ITEM, ITEM_INDEX.log, -1],
      [KIND.ITEM, ITEM_INDEX.torch, 2],
    ]
  );
});

test('после факела первым доступным идёт каменный блок', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  inventory.add('stone', 4);
  const recipe = recipeAt(inventory, 'craft', 'workbench');
  assert.equal(recipe.id, 'make-block');
  assert.equal(applyRecipeAt(recipe, inventory, 'workbench'), true);
  assert.deepEqual([inventory.count('stone'), inventory.count('block')], [0, 1]);
});

test('железистый камень обтёсывается в блок без скрытой переплавки', () => {
  const journal = new Journal();
  const inventory = new Inventory(journal);
  inventory.add('ore', 2);
  const recipe = recipeAt(inventory, 'craft', 'workbench');
  assert.equal(recipe.id, 'dress-ore');
  const before = journal.count;
  assert.equal(applyRecipeAt(recipe, inventory, 'workbench'), true);
  assert.deepEqual([inventory.count('ore'), inventory.count('block')], [0, 1]);
  assert.deepEqual(
    [...journal.records()].slice(before).map((r) => [r.kind, r.id, r.delta]),
    [[KIND.ITEM, ITEM_INDEX.ore, -2], [KIND.ITEM, ITEM_INDEX.block, 1]]
  );
  assert.equal(applyRecipeAt(recipe, inventory, 'workbench'), false);
  assert.equal(inventory.count('block'), 1);
});
