import { ITEMS, ITEM_INDEX } from './data/items.js';
import { RECIPES } from './data/recipes.js';

function hasTake(recipe, inventory) {
  return Object.entries(recipe.take).every(([id, n]) => inventory.count(id) >= n);
}

function hasRoom(recipe, inventory) {
  return Object.entries(recipe.give).every(([id, n]) => {
    const index = ITEM_INDEX[id];
    return index !== undefined && inventory.count(id) + n <= ITEMS[index].stack;
  });
}

/** Первый доступный рецепт указанного действия и места. */
export function recipeAt(inventory, verb, station) {
  return RECIPES.find((recipe) =>
    recipe.verb === verb && recipe.station === station && hasTake(recipe, inventory)
      && hasRoom(recipe, inventory)
  ) || null;
}

/** Атомарно применить рецепт только у указанной станции. */
export function applyRecipeAt(recipe, inventory, station) {
  if (!recipe || recipe.verb !== 'craft' || recipe.station !== station) return false;
  if (!hasTake(recipe, inventory) || !hasRoom(recipe, inventory)) return false;
  for (const [id, n] of Object.entries(recipe.take)) inventory.take(id, n);
  for (const [id, n] of Object.entries(recipe.give)) inventory.add(id, n);
  return true;
}
