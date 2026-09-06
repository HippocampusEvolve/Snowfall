import * as THREE from 'three';
import { HeldTool, VIEW_Z } from 'world-core/core';
import { selectLitTorches } from './torch-lights.js';
import { quantizePlacement } from './placements.js';
import { createGameProp, disposeModel } from './props/lab/tools.js';
import { attachToolGrip } from './hand-model.js';

export { countTorchTriangles } from './torch-geometry.js';
export { selectLitTorches } from './torch-lights.js';
export const TORCH_LIGHT_SLOTS = 2;
export const TORCH_FUEL_SECONDS = 600;
export const TORCH_BLOWOUT_SECONDS = 10;
const REST = new THREE.Euler(-0.12, 0.08, 0.06);
const PIVOT_Y = 0.144;
// Flame reaches 0.78 m above the base. The base is below frame centre so the
// complete flame fits the 55-degree view camera even with walking/sway.
const TIP = new THREE.Vector3(0.24, -0.40, -0.70 * VIEW_Z);
const freshState = () => ({ fuel: TORCH_FUEL_SECONDS, burning: false, exposure: 0 });
const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
const unit = value => THREE.MathUtils.clamp(finite(value, 0), 0, 1);

function readState(record = {}, legacy = false) {
  if (!record || typeof record !== 'object') record = {};
  const fuel = THREE.MathUtils.clamp(finite(record.fuel, TORCH_FUEL_SECONDS), 0, TORCH_FUEL_SECONDS);
  return { fuel, burning: fuel > 0 && (record.burning === true || (legacy && record.burning === undefined)),
    exposure: THREE.MathUtils.clamp(finite(record.exposure, 0), 0, TORCH_BLOWOUT_SECONDS) };
}

export function advanceTorchState(state, dt, weather = {}) {
  if (!state.burning || weather.spend === false) return;
  const seconds = Math.max(0, finite(dt, 0));
  const wind = unit(weather.blizzard) * (1 - unit(weather.shelter));
  state.fuel = Math.max(0, state.fuel - seconds * (1 + wind * 0.3));
  state.exposure = wind >= 0.72 ? state.exposure + seconds * wind
    : Math.max(0, state.exposure - seconds * 2);
  if (state.fuel <= 0 || state.exposure >= TORCH_BLOWOUT_SECONDS) state.burning = false;
}

function animateModel(model, state, time) {
  const flame = model.userData.flame;
  flame.visible = state.burning;
  flame.material.uniforms.uTime.value = time;
  // A dwindling flame gives a physical warning, with no resource HUD.
  flame.scale.x = flame.scale.z = 0.55 + Math.min(1, state.fuel / 50) * 0.45;
}

export class Torch extends HeldTool {
  constructor(scene, view) {
    super(scene, view, {
      build: () => createGameProp('torch'), rest: REST, pivotY: PIVOT_Y, tip: TIP, strokes: {},
      plantPose(world, x, y, z) { world.position.set(x, y, z); },
    });
    this.scene = scene;
    this.placed = [];
    this._state = freshState();
    this._carriedState = false;
    this.heldLight = new THREE.PointLight(0xffac59, 0, 9, 2);
    scene.add(this.heldLight);
    attachToolGrip(this);
    // World lights cannot reach the separately rendered viewmodel scene.
    // Put this source just in front of the flame, so it warms the binding,
    // shaft and mitten while the world light illuminates the surroundings.
    this.viewLight = new THREE.PointLight(0xffa44f, 0, 2, 2);
    this.viewLight.name = 'Carried torch glow';
    this.viewLight.position.set(0, 0.57, 0.10);
    this.swing.children[0].add(this.viewLight);
    this._restX = this.holder.position.x;
    animateModel(this.swing.children[0], this._state, 0);
  }

  get burning() { return this.held && this._state.burning; }
  get fuel() { return this._state.fuel; }
  get needsFuel() { return this.fuel <= 0; }
  get heat() { return this.burning ? 0.12 * Math.min(1, this.fuel / 30) : 0; }

  ignite() {
    if (!this.held || this._state.burning || this.fuel <= 0) return false;
    this._state.burning = true;
    this._state.exposure = 0;
    return true;
  }

  take() {
    if (!this._carriedState) this._state = freshState();
    this._carriedState = true;
    super.take();
    animateModel(this.swing.children[0], this._state, 0);
  }

  _addPlaced(position, id = 0, state = freshState()) {
    const model = createGameProp('torch');
    model.position.copy(position);
    this.scene.add(model);
    const light = new THREE.PointLight(0xffa44f, 0, 9, 2);
    light.position.set(position.x, position.y + 0.64, position.z);
    this.scene.add(light);
    const entry = { id, position: position.clone(), model, light, ...readState(state) };
    animateModel(model, entry, 0);
    this.placed.push(entry);
    return entry;
  }

  _removePlaced(entry) {
    const index = this.placed.indexOf(entry);
    if (index < 0) return false;
    this.placed.splice(index, 1);
    this.scene.remove(entry.model, entry.light);
    disposeModel(entry.model);
    return true;
  }

  stow() {
    this.held = false;
    this.holder.visible = false;
    this._state.burning = false;
    this.heldLight.intensity = 0;
    this.viewLight.intensity = 0;
    this._rest();
  }

  plantAt(position, inventory, notePlace) {
    if (!this.held || inventory.take('torch', 1) !== 1) return null;
    const q = quantizePlacement(position);
    const id = notePlace(q, false);
    const entry = this._addPlaced(new THREE.Vector3(q.x, q.y, q.z), id, this._state);
    this._carriedState = false;
    this.held = false;
    this.holder.visible = false;
    this.heldLight.intensity = 0;
    this.viewLight.intensity = 0;
    this._rest();
    return entry;
  }

  takePlaced(entry, inventory, notePlace) {
    if (!this.placed.includes(entry) || inventory.add('torch', 1) !== 1) return false;
    notePlace(entry.position, true);
    this._state = readState(entry);
    this._carriedState = true;
    this._removePlaced(entry);
    this.take();
    return true;
  }

  // Old placement journals had no fuel information and depicted lit torches.
  restore(records = []) {
    for (const entry of [...this.placed]) this._removePlaced(entry);
    for (const record of Array.isArray(records) ? records : []) {
      if (!record || typeof record !== 'object') continue;
      if (![record.x, record.y, record.z].every(Number.isFinite)) continue;
      this._addPlaced(new THREE.Vector3(record.x, record.y, record.z), record.seq ?? record.id, readState(record, true));
    }
  }

  snapshot() {
    return { version: 1, held: this._carriedState ? { ...this._state } : null,
      placed: this.placed.map(entry => ({ id: entry.id, x: entry.position.x, y: entry.position.y,
        z: entry.position.z, fuel: entry.fuel, burning: entry.burning, exposure: entry.exposure })) };
  }

  restoreState(snapshot, { elapsedSeconds = 0, legacyHeld = false } = {}) {
    const elapsed = Math.max(0, finite(elapsedSeconds, 0));
    if (!snapshot || snapshot.version !== 1) {
      this._carriedState = legacyHeld;
      this._state = readState({}, legacyHeld);
      for (const entry of this.placed) advanceTorchState(entry, elapsed);
      if (legacyHeld) advanceTorchState(this._state, elapsed);
      return false;
    }
    // Apply state only to placements present in the authoritative journal.
    for (const record of Array.isArray(snapshot.placed) ? snapshot.placed : []) {
      if (!record || ![record.x, record.y, record.z].every(Number.isFinite)) continue;
      const entry = this.placed.find(p => p.id === record.id
        && p.position.distanceToSquared(new THREE.Vector3(record.x, record.y, record.z)) < 0.01);
      if (entry) Object.assign(entry, readState(record));
    }
    this._carriedState = !!snapshot.held && typeof snapshot.held === 'object';
    this._state = this._carriedState ? readState(snapshot.held) : freshState();
    for (const entry of this.placed) advanceTorchState(entry, elapsed);
    if (this._carriedState) advanceTorchState(this._state, elapsed);
    return true;
  }

  update(dt, time, camera, lightSlots = TORCH_LIGHT_SLOTS, weather = {}) {
    super.update(dt, () => false);
    this.holder.position.x = this._restX * THREE.MathUtils.clamp((camera.aspect || 1.5) / 1.2, 0.42, 1);
    if (this.held) advanceTorchState(this._state, dt, weather);
    animateModel(this.swing.children[0], this._state, time);
    const flicker = 0.92 + Math.sin(time * 9.7) * 0.05 + Math.sin(time * 23.1) * 0.03;
    const strength = Math.min(1, this.fuel / 30);
    this.heldLight.intensity = this.burning && lightSlots > 0 ? 6 * flicker * strength : 0;
    this.viewLight.intensity = this.burning ? 0.9 * flicker * strength : 0;
    if (this.burning) {
      camera.getWorldDirection(this.heldLight.position);
      this.heldLight.position.multiplyScalar(0.55).add(camera.position);
      this.heldLight.position.y -= 0.05;
    }
    for (const entry of this.placed) {
      advanceTorchState(entry, dt, { ...weather, shelter: weather.shelterAt?.(entry.position) ?? 0 });
      animateModel(entry.model, entry, time);
    }
    const limit = Math.max(0, lightSlots - (this.burning ? 1 : 0));
    const lit = new Set(selectLitTorches(this.placed.filter(p => p.burning), camera.position, limit));
    for (let i = 0; i < this.placed.length; i++) {
      const entry = this.placed[i];
      entry.light.intensity = lit.has(entry)
        ? 5.5 * Math.min(1, entry.fuel / 30) * (0.93 + Math.sin(time * 8.3 + i * 1.7) * 0.07) : 0;
    }
  }
}
