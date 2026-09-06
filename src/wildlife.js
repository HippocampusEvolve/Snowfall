import * as THREE from 'three';
import { createRandom } from './props/lab/generators.js';
import { createRabbit } from './props/lab/rabbit.js';
import { createRabbitBehavior } from './props/lab/rabbit-behavior.js';
import { createRabbitMaterials } from './props/lab/materials.js';
import { disposeModel } from './props/lab/tools.js';

export const RABBIT_SCALE = 0.29;
export const SIGHTING_DELAY = 55;

/** surfaceAt(x,z) returns a finite outdoor ground height, or null when unloaded.
 * canStand(x,z,y) rejects trees, buildings, caves and player construction.
 * The complete meadow is sampled so the rabbit cannot begin inside an obstacle. */
export function findRabbitPatch(origin, seed, surfaceAt, canStand = () => true, direction = null) {
  const random = createRandom(seed);
  for (let attempt = 0; attempt < 24; attempt++) {
    const angle = random() * Math.PI * 2, radius = 25 + random() * 13;
    const x = origin.x + Math.sin(angle) * radius, z = origin.z + Math.cos(angle) * radius;
    if (direction && ((x - origin.x) * direction.x + (z - origin.z) * direction.z) / radius > 0.2) continue;
    const y = surfaceAt(x, z);
    if (!Number.isFinite(y) || Math.abs(y - origin.y) > 8 || !canStand(x, z, y)) continue;
    let safe = true;
    for (let dx = -4; dx <= 4 && safe; dx += 1) for (let dz = -4; dz <= 4; dz += 1) {
      const ground = surfaceAt(x + dx, z + dz);
      if (!Number.isFinite(ground) || Math.abs(ground - y) > 1.1 || !canStand(x + dx, z + dz, ground)) { safe = false; break; }
      for (const [sx, sz] of [[0.35, 0], [0, 0.35]]) {
        const next = surfaceAt(x + dx + sx, z + dz + sz);
        if (!Number.isFinite(next) || Math.abs(next - ground) > 0.17) { safe = false; break; }
      }
    }
    if (!safe) continue;
    return { x, y, z, yaw: random() * Math.PI * 2,
      meadow: { minX: x - 4, maxX: x + 4, minZ: z - 4, maxZ: z + 4 },
      patches: [[x - 2, z + 2], [x + 2, z + 1], [x - 1, z - 2], [x + 2, z - 2]] };
  }
  return null;
}

export class Wildlife {
  constructor(scene, { surfaceAt, canStand = () => true, seed = 7319, workerFactory } = {}) {
    this.scene = scene;
    this.surfaceAt = surfaceAt;
    this.canStand = canStand;
    this.seed = seed;
    this.workerFactory = workerFactory ?? (() => new Worker(new URL('./wildlife.worker.js', import.meta.url), { type: 'module' }));
    this.rabbit = null;
    this.behavior = null;
    this.active = false;
    this.failed = false;
    this.disposed = false;
    this.clock = 0;
    this.nextSighting = SIGHTING_DELAY;
    this.sightings = 0;
    this.age = 0;
    this.scareCooldown = 0;
  }

  init() {
    if (this.pending) return this.pending;
    if (this.rabbit || this.failed || this.disposed) return Promise.resolve(!!this.rabbit);
    this.pending = new Promise(resolve => {
      let worker;
      let finished = false;
      const finish = ok => {
        if (finished) return;
        finished = true;
        clearTimeout(this.timeout);
        worker?.terminate(); this.worker = null;
        if (!ok) this.failed = true;
        this._finish = null;
        resolve(ok);
      };
      this._finish = finish;
      try {
        worker = this.workerFactory(); this.worker = worker;
        this.timeout = setTimeout(() => finish(false), 30000);
        worker.onerror = () => finish(false);
        worker.onmessage = ({ data }) => {
          if (finished) return;
          if (data.error || this.disposed) { finish(false); return; }
          try {
            const geometry = new THREE.BufferGeometry();
            for (const [name, attribute] of Object.entries(data.attributes)) {
              geometry.setAttribute(name, new THREE.BufferAttribute(attribute.array, attribute.itemSize));
            }
            this.rabbit = createRabbit(this.seed, createRabbitMaterials(), geometry);
            this.rabbit.root.scale.setScalar(RABBIT_SCALE);
            this.rabbit.root.visible = false;
            this.scene.add(this.rabbit.root);
            finish(true);
          } catch { finish(false); }
        };
        worker.postMessage({ seed: this.seed });
      } catch { finish(false); }
    });
    return this.pending;
  }

  update(dt, time, player, weather = {}) {
    if (this.failed || this.disposed || weather.spend === false) return;
    const step = Math.max(0, Math.min(0.25, Number.isFinite(dt) ? dt : 0));
    this.clock += step;
    const outdoors = (weather.shelter ?? 0) < 0.4 && (weather.blizzard ?? 0) < 0.7;
    if (!this.active) {
      if (!outdoors || this.clock < this.nextSighting) return;
      if (!this.rabbit) { void this.init(); return; }
      const patch = findRabbitPatch(player, this.seed + this.sightings * 131,
        this.surfaceAt, this.canStand, weather.direction);
      this.nextSighting = this.clock + 90;
      this.sightings++;
      if (!patch) return;
      this.behavior = createRabbitBehavior(this.seed + this.sightings, this.surfaceAt,
        { placement: patch, meadow: patch.meadow, patches: patch.patches, canStand: this.canStand });
      this.active = true;
      this.age = 0;
      this.scareCooldown = 0;
    }
    const state = this.behavior.state;
    const distance = Math.hypot(state.x - player.x, state.z - player.z);
    this.age += step;
    this.scareCooldown -= step;
    if ((distance < 7 || this.age > 65) && this.scareCooldown <= 0) {
      this.behavior.scare(player); this.scareCooldown = 3;
    }
    // Retire a sighting out of view. A close rabbit never blinks out on a timer.
    const behind = weather.direction && (state.x - player.x) * weather.direction.x
      + (state.z - player.z) * weather.direction.z < 0;
    if (distance > 55 || (!outdoors && distance > 20)
      || (this.age > 80 && (distance > 32 || (behind && distance > 14)))) {
      this.active = false; this.rabbit.root.visible = false;
      this.nextSighting = this.clock + 100 + createRandom(this.seed + this.sightings)() * 100;
      return;
    }
    this.behavior.advance(step);
    this.rabbit.root.visible = true;
    this.rabbit.root.position.set(state.x, state.groundY + state.hopHeight - 0.022 * RABBIT_SCALE, state.z);
    this.rabbit.root.rotation.y = state.yaw;
    this.rabbit.update(time, weather.reducedMotion === true, state);
  }

  dispose() {
    this.disposed = true;
    this._finish?.(false);
    if (this.rabbit) { this.scene.remove(this.rabbit.root); disposeModel(this.rabbit.root); }
  }
}
