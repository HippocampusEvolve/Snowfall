import { createRandom } from './generators.js';
import { RABBIT_PLACEMENT } from './rabbit.js';

export const MEADOW = { minX: -8.6, maxX: -4.85, minZ: 0.5, maxZ: 6.7 };
export const GRASS_PATCHES = [[-5.14, 3.63], [-6.2, 4.8], [-7.65, 3.1], [-6.8, 1.5], [-7.6, 5.6], [-5.3, 5.9]];
export const RABBIT_STATE_NAMES = { idle: 'Осматривается', graze: 'Щиплет траву', move: 'Ищет траву', flee: 'Убегает', alert: 'Прислушивается' };
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = x => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

export function createRabbitBehavior(seed, heightAt, options = {}) {
  const meadow = options.meadow ?? MEADOW;
  const patches = options.patches ?? GRASS_PATCHES;
  const placement = options.placement ?? RABBIT_PLACEMENT;
  const canStand = options.canStand ?? (() => true);
  const random = createRandom(seed + 9187);
  const state = { mode: 'idle', x: placement.x, z: placement.z, yaw: placement.yaw ?? 0, groundY: 0,
    hopHeight: 0, flight: 0, speed: 0, graze: 0, crouch: 0, scared: 0,
    time: 0, patch: 0, eaten: patches.map(() => 0) };
  let accumulator = 0, age = 0, duration = 1.5, hop = null, cooldown = 0;
  let target = { x: state.x, z: state.z };
  const setMode = (mode, seconds) => { state.mode = mode; age = 0; duration = seconds; };
  const chooseGrass = () => {
    state.patch = (state.patch + 1 + Math.floor(random() * (patches.length - 1))) % patches.length;
    const [x, z] = patches[state.patch];
    let yaw = Math.atan2(x - state.x, z - state.z);
    if (x - Math.sin(yaw) * 0.83 < meadow.minX || x - Math.sin(yaw) * 0.83 > meadow.maxX
      || z - Math.cos(yaw) * 0.83 < meadow.minZ || z - Math.cos(yaw) * 0.83 > meadow.maxZ) {
      yaw = Math.atan2(x - (meadow.minX + meadow.maxX) / 2, z - (meadow.minZ + meadow.maxZ) / 2);
    }
    target = { x: clamp(x - Math.sin(yaw) * 0.83, meadow.minX, meadow.maxX),
      z: clamp(z - Math.cos(yaw) * 0.83, meadow.minZ, meadow.maxZ), yaw };
    setMode('move', Infinity);
  };
  const scare = (point) => {
    // Change destination now, but finish a current ballistic arc before the
    // next hop. Clicking mid-jump must never teleport the animal to ground.
    let best = null, score = -Infinity;
    for (let i = 0; i < 24; i++) {
      const x = meadow.minX + 0.15 + random() * (meadow.maxX - meadow.minX - 0.3);
      const z = meadow.minZ + 0.15 + random() * (meadow.maxZ - meadow.minZ - 0.3);
      const y = heightAt(x, z);
      if (!Number.isFinite(y) || !canStand(x, z, y)) continue;
      const s = Math.hypot(x - point.x, z - point.z) - Math.hypot(x - state.x, z - state.z) * 0.08;
      if (s > score) { score = s; best = { x, z }; }
    }
    if (best) { target = best; cooldown = 0; setMode('flee', Infinity); }
  };
  const beginHop = () => {
    const dx = target.x - state.x, dz = target.z - state.z, distance = Math.hypot(dx, dz);
    if (distance < 0.025) {
      if (state.mode === 'flee') setMode('alert', 2.2 + random());
      else setMode('graze', 5 + random() * 3);
      return;
    }
    const fast = state.mode === 'flee';
    const length = Math.min(distance, fast ? 1.25 : 0.58);
    // Snowfall terrain can change after digging. Validate the whole next arc
    // before moving; the original lab meadow never had holes or buildings.
    let previousY = heightAt(state.x, state.z);
    for (let i = 1; i <= 5; i++) {
      const x = state.x + dx / distance * length * i / 5;
      const z = state.z + dz / distance * length * i / 5;
      const y = heightAt(x, z);
      if (!Number.isFinite(y) || !canStand(x, z, y) || Math.abs(y - previousY) > 0.16) {
        setMode('alert', 1.8); return;
      }
      previousY = y;
    }
    hop = { x: state.x, z: state.z, toX: state.x + dx / distance * length,
      toZ: state.z + dz / distance * length, elapsed: 0,
      duration: fast ? 0.44 : 0.70, height: fast ? 0.48 : 0.22,
      yaw: state.yaw, toYaw: Math.atan2(dx, dz), fast };
  };
  const tick = dt => {
    state.time += dt; age += dt;
    state.graze += ((state.mode === 'graze' ? 1 : 0) - state.graze) * dt * 4.5;
    if (state.mode === 'graze') state.yaw += angleDelta(state.yaw, target.yaw ?? state.yaw) * dt * 4.5;
    state.scared += ((state.mode === 'flee' ? 1 : 0) - state.scared) * dt * 8;
    state.eaten = state.eaten.map(v => Math.max(0, v - dt * 0.006));
    if (state.mode === 'graze') state.eaten[state.patch] = Math.min(0.68, state.eaten[state.patch] + dt * 0.055);
    if (hop) {
      hop.elapsed = Math.min(hop.duration, hop.elapsed + dt);
      const t = hop.elapsed / hop.duration;
      const u = clamp((t - 0.12) / 0.72, 0, 1);
      state.x = hop.x + (hop.toX - hop.x) * smooth(u);
      state.z = hop.z + (hop.toZ - hop.z) * smooth(u);
      state.yaw = hop.yaw + angleDelta(hop.yaw, hop.toYaw) * smooth(t / 0.25);
      state.hopHeight = Math.sin(Math.PI * u) * hop.height;
      state.flight = u; state.speed = hop.fast ? 3 : 1;
      state.crouch = t < 0.12 ? Math.sin(Math.PI * t / 0.12) : t > 0.84 ? Math.sin(Math.PI * (t - 0.84) / 0.16) : 0;
      if (t >= 1) { hop = null; state.hopHeight = 0; state.flight = 0; state.speed = 0; state.crouch = 0; cooldown = state.mode === 'flee' ? 0.025 : 0.18; }
    } else if (state.mode === 'move' || state.mode === 'flee') {
      cooldown -= dt;
      // Lift the head before moving off from the grass.
      if (cooldown <= 0 && state.graze < 0.14) beginHop();
    } else if (age >= duration) {
      if (state.mode === 'idle') setMode('graze', 6.5);
      else if (state.mode === 'graze') setMode('alert', 1.6);
      else chooseGrass();
    }
    const groundY = heightAt(state.x, state.z);
    if (Number.isFinite(groundY)) state.groundY = groundY;
  };
  state.groundY = heightAt(state.x, state.z);
  return {
    state, scare,
    advance(delta, paused = false) {
      if (paused) return state;
      accumulator += clamp(delta, 0, 0.25);
      while (accumulator >= 1 / 120) { tick(1 / 120); accumulator -= 1 / 120; }
      return state;
    },
  };
}
