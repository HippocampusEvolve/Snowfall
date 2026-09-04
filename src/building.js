import { RECIPES } from './data/recipes.js';

export function buildRecipeFor(inventory) {
  return RECIPES.find((recipe) => recipe.verb === 'build' &&
    Object.entries(recipe.take).every(([id, n]) => inventory.count(id) >= n)
  ) || null;
}

export function buildAvoided(center, avoid, radius = 0) {
  return avoid.some((area) => Math.hypot(center.x - area.x, center.z - area.z) < area.r + radius);
}

// Применение общее для всех рецептов: таблица решает, что уйдёт и что появится.
export function applyRecipe(recipe, inventory, digger, center, avoid = []) {
  if (!recipe || recipe.verb !== 'build') return false;
  if (buildAvoided(center, avoid, recipe.give.radius)) return false;
  if (!Object.entries(recipe.take).every(([id, n]) => inventory.count(id) >= n)) return false;

  digger.buildStroke(
    center,
    recipe.give.radius,
    recipe.give.strength,
    recipe.give.material
  );
  for (const [id, n] of Object.entries(recipe.take)) inventory.take(id, n);
  return true;
}
