// A full hearth lasts eighteen minutes. One carried log adds six minutes.
// Embers are a visible way to relight the hearth, not a source of free heat.
export const HEARTH_FUEL_SECONDS = 18 * 60;
export const HEARTH_LOG_FUEL = 1 / 3;
export const HEARTH_INITIAL_FUEL = 2 / 3;

const clampFuel = (value, fallback = 0) => Number.isFinite(value)
  ? Math.max(0, Math.min(1, value)) : fallback;

export function createHearthState(initial = HEARTH_INITIAL_FUEL) {
  let fuel = clampFuel(initial, HEARTH_INITIAL_FUEL);
  const age = (seconds) => {
    if (Number.isFinite(seconds) && seconds > 0) fuel = Math.max(0, fuel - seconds / HEARTH_FUEL_SECONDS);
    return fuel;
  };
  return {
    get fuel() { return fuel; },
    set fuel(value) { fuel = clampFuel(value); },
    get heatK() { return Math.min(1, fuel * 2.4); },
    get burning() { return fuel > 0; },
    addFuel(amount = HEARTH_LOG_FUEL) {
      const before = fuel;
      fuel = clampFuel(fuel + clampFuel(amount));
      return fuel - before;
    },
    age,
    update(dt, spend = true) { if (spend) age(dt); },
    snapshot() { return { fuel }; },
    restore(state, { elapsedSeconds = 0 } = {}) {
      fuel = clampFuel(state?.fuel, HEARTH_INITIAL_FUEL);
      age(elapsedSeconds);
    },
  };
}
