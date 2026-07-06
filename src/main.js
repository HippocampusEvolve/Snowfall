import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Terrain } from './terrain.js';
import { SnowPatch } from './snowpatch.js';
import { Footprints } from './footprints.js';
import { Sky } from './sky.js';
import { Snowfall } from './snowfall.js';
import { createTrees } from './trees.js';
import { createRidges } from './ridges.js';
import { Aurora } from './aurora.js';
import { Breath } from './breath.js';
import { Campfire } from './campfire.js';
import { Player } from './player.js';
import { GameAudio } from './audio.js';
import { Stats } from './stats.js';

// ---------- рендерер ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

// ---------- сцена ----------
const scene = new THREE.Scene();
const FOG_CALM = 0.011;
const FOG_STORM = 0.024;
scene.fog = new THREE.FogExp2(0x0a1322, FOG_CALM);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

// луна и свет
const moonDir = new THREE.Vector3(-0.45, 0.58, -0.68).normalize();
const moonLight = new THREE.DirectionalLight(0xbfd2ff, 1.5);
moonLight.position.copy(moonDir).multiplyScalar(180);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
moonLight.shadow.camera.left = -95;
moonLight.shadow.camera.right = 95;
moonLight.shadow.camera.top = 95;
moonLight.shadow.camera.bottom = -95;
moonLight.shadow.camera.near = 20;
moonLight.shadow.camera.far = 400;
moonLight.shadow.bias = -0.0006;
scene.add(moonLight);
scene.add(moonLight.target);

const hemi = new THREE.HemisphereLight(0x203258, 0x0b0e18, 0.55);
scene.add(hemi);

// ---------- мир ----------
const footprints = new Footprints(renderer, 160);
const terrain = new Terrain(footprints, renderer.capabilities.getMaxAnisotropy());
scene.add(terrain.mesh);

// деформируемый снег вокруг игрока
const snowPatch = new SnowPatch(footprints, terrain);
scene.add(snowPatch.mesh);

const sky = new Sky(moonDir);
scene.add(sky.group);

const ridges = createRidges();
scene.add(ridges.group);

const aurora = new Aurora(Math.atan2(-moonDir.x, -moonDir.z));
scene.add(aurora.mesh);

const snow = new Snowfall();
scene.add(snow.points);

// лес и камни (модели Quaternius, CC0)
const trees = await createTrees(terrain);
scene.add(trees.group);

// костёр — дом и очаг
const FIRE = { x: 2.5, z: -9 };
const campfire = new Campfire(scene, terrain, FIRE.x, FIRE.z);
trees.obstacles.push({ x: FIRE.x, z: FIRE.z, r: 0.85 });

// ---------- аудио, игрок, дыхание, статы ----------
const audio = new GameAudio();

const player = new Player(
  camera,
  renderer.domElement,
  terrain,
  (fx, fz, dir, side, running) => {
    footprints.stamp(fx, fz, dir, side);
    audio.footstep(running);
  },
  trees.obstacles
);

const breath = new Breath(scene, camera, (exertion) => audio.breath(exertion));
const stats = new Stats();

// ---------- постобработка ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.45,
  0.65,
  0.82
);
composer.addPass(bloom);
composer.addPass(new OutputPass());

// ---------- UI ----------
const menu = document.getElementById('menu');
const loading = document.getElementById('loading');
const hud = document.getElementById('hud');
const statsEl = document.getElementById('stats');
const playBtn = document.getElementById('play');

playBtn.addEventListener('click', () => {
  audio.init();
  audio.resume();
  player.controls.lock();
});
player.controls.addEventListener('lock', () => {
  menu.classList.add('hidden');
  statsEl.classList.add('show');
  audio.resume();
  setTimeout(() => hud.classList.add('faded'), 6000);
});
player.controls.addEventListener('unlock', () => {
  if (!stats.dead) menu.classList.remove('hidden');
});

// прелоадер: пара кадров на прогрев шейдеров + проталина у костра
requestAnimationFrame(() => {
  composer.render();
  footprints.stampCircle(FIRE.x, FIRE.z, 1.9, 1);
  loading.classList.add('hidden');
  if (player.debug) {
    statsEl.classList.add('show');
    const initAudio = () => {
      audio.init();
      audio.resume();
      removeEventListener('keydown', initAudio);
    };
    addEventListener('keydown', initAudio);
  } else {
    menu.classList.remove('hidden');
  }
});

// ---------- resize ----------
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  composer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- цикл ----------
const clock = new THREE.Clock();
let fadeAcc = 0;
let meltAcc = 0;
let blizzard = 0; // 0..1 — сглаженная сила метели
const _toFire = new THREE.Vector3();
const _camRight = new THREE.Vector3();

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // метель: плавно следует за порывами ветра из аудио
  blizzard += (Math.max(0, audio.windLevel - 0.35) / 0.65 - blizzard) * Math.min(1, dt * 0.35);
  scene.fog.density = FOG_CALM + blizzard * (FOG_STORM - FOG_CALM);
  for (const m of ridges.mats) m.opacity = 1 - blizzard * 0.8;

  player.update(dt);
  snowPatch.update(camera.position);
  snow.update(dt, t, camera.position, audio.windLevel, blizzard);
  sky.update(t);
  aurora.update(t, blizzard);
  breath.update(dt, player.exertion, audio.windLevel);
  campfire.update(dt, t, audio.windLevel);

  // тепло от костра + позиционный звук
  _toFire.copy(campfire.position).sub(camera.position);
  const fireDist = Math.hypot(_toFire.x, _toFire.z);
  const heat = THREE.MathUtils.clamp(1 - (fireDist - 1.2) / 3.5, 0, 1);
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  const pan = fireDist > 0.3 ? (_toFire.x * _camRight.x + _toFire.z * _camRight.z) / fireDist : 0;
  audio.updateCampfire(fireDist, pan);
  stats.update(dt, blizzard, player, heat);

  // снег постепенно заметает следы, но у костра — вечная проталина
  fadeAcc += dt;
  if (fadeAcc > 0.25) {
    fadeAcc = 0;
    footprints.fade();
  }
  meltAcc += dt;
  if (meltAcc > 3) {
    meltAcc = 0;
    footprints.stampCircle(FIRE.x, FIRE.z, 1.9, 0.08);
  }

  composer.render();
}
tick();
