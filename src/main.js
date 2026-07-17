import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Terrain } from './terrain.js';
import { SnowPatch } from './snowpatch.js';
import { Digger } from './digger.js';
import { Footprints } from './footprints.js';
import { Sky } from './sky.js';
import { Snowfall } from './snowfall.js';
import { createTrees } from './trees.js';
import { createCabin } from './cabin.js';
import { createRidges } from './ridges.js';
import { Aurora } from './aurora.js';
import { Breath } from './breath.js';
import { Campfire } from './campfire.js';
import { Player } from './player.js';
import { GameAudio } from './audio.js';
import { Stats } from './stats.js';
import { Critters } from './critters.js';
import { createWoodpile, createCarriedLog, GroundLogs } from './firewood.js';
import { initSnowCap } from './snowcap.js';
import { Shovel } from './shovel.js';
import { ViewModel, VIEW_Z } from './viewmodel.js';
import { SaveGame } from './save.js';
import { SmoothLook } from './look.js';

// ---------- рендерер ----------
// Ярусы качества теней (?shadows=high|medium|low): размер карты, фильтр,
// период обновления. Карта перерисовывается по таймеру и по событиям, а не
// каждый кадр — луна за интервал сдвигается на сотые доли градуса.
const SHADOW_TIER =
  {
    high: { size: 2048, soft: true, interval: 0.25 },
    medium: { size: 1024, soft: false, interval: 0.5 },
    low: { size: 512, soft: false, interval: 1.0 },
  }[new URLSearchParams(location.search).get('shadows')] ||
  { size: 2048, soft: true, interval: 0.25 };
const SHADOW_HALF = 38; // полуразмер окна карты теней вокруг игрока, м

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = SHADOW_TIER.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // взводим needsUpdate сами (см. блок теней в тике)
renderer.shadowMap.needsUpdate = true; // первый кадр — с тенями
let shadowDirty = false; // событие изменило кастеры → перерисовать тень в следующем кадре
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);

// ---------- сцена ----------
const scene = new THREE.Scene();
const FOG_CALM = 0.011;
const FOG_STORM = 0.024;
scene.fog = new THREE.FogExp2(0x0a1322, FOG_CALM);

const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 2000);

// луна и свет. Луна ЖИВАЯ: Sky ведёт moonDir по полярному кругу (мутирует
// этот же вектор), а тик каждый кадр подтягивает за ней DirectionalLight —
// тени медленно плывут по снегу даже у неподвижного игрока
const moonDir = new THREE.Vector3(-0.45, 0.58, -0.68).normalize();
const moonLight = new THREE.DirectionalLight(0xbfd2ff, 1.5);
moonLight.position.copy(moonDir).multiplyScalar(180);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(SHADOW_TIER.size, SHADOW_TIER.size);
// окно теней едет за игроком (блок теней в тике): ±SHADOW_HALF вместо прежнего
// статического ±95 — те же тексели ложатся ~в 2.5 раза плотнее, тени чётче;
// дальние тени за окном скрадывает туман. near/far не поджать: на минимальной
// высоте луны (0.22 рад) наземный след окна вытягивается вдоль азимута на ±170 м
moonLight.shadow.camera.left = -SHADOW_HALF;
moonLight.shadow.camera.right = SHADOW_HALF;
moonLight.shadow.camera.top = SHADOW_HALF;
moonLight.shadow.camera.bottom = -SHADOW_HALF;
moonLight.shadow.camera.near = 20;
moonLight.shadow.camera.far = 400;
moonLight.shadow.bias = -0.0006;
// у кривых MC-поверхностей ям с плотными текселями первым вылезает полосатое
// акне — normalBias отодвигает сэмпл вдоль нормали и глушит его
moonLight.shadow.normalBias = 0.03;
scene.add(moonLight);
scene.add(moonLight.target);

// нижний цвет — отскок лунного света от яркого снега. Поднят до насыщенной
// лунной синевы: он заполняет грани, смотрящие вниз/вбок (низ кроны, теневой
// к камере бок ствола), которые луна не достаёт вовсе, — без него ближнее
// дерево проваливалось в плоский чёрный и выпадало из синей палитры мира.
// Снег смотрит вверх и освещается ВЕРХНИМ цветом, поэтому его яркость не растёт.
const hemi = new THREE.HemisphereLight(0x223560, 0x33517e, 0.9);
scene.add(hemi);

// ---------- мир ----------
const footprints = new Footprints(renderer, 160);
const terrain = new Terrain(footprints, renderer.capabilities.getMaxAnisotropy());
scene.add(terrain.mesh);

// снежные шапки (крыша, дрова) берут те же текстуры снега, что земля и раскоп —
// вещество едино по всему миру; задаём до создания сруба/поленницы
initSnowCap(terrain.textures);

// деформируемый снег вокруг игрока
const snowPatch = new SnowPatch(footprints, terrain);
scene.add(snowPatch.mesh);

// воксельное копание (Digger): реальный 3D-объём — ямы, тоннели, пещеры
const digger = new Digger(scene, terrain, snowPatch, footprints);
digger.onChanged = () => { shadowDirty = true; }; // перестройка ямы → тень заново

const sky = new Sky(moonDir);
scene.add(sky.group);

const ridges = createRidges();
scene.add(ridges.group);

const aurora = new Aurora(Math.atan2(-moonDir.x, -moonDir.z));
scene.add(aurora.mesh);

const snow = new Snowfall();
scene.add(snow.points);

// домик с тёплыми окнами + лес (сосны LOLIPOP, камни Quaternius);
// вокруг домика — поляна без деревьев
const CABIN = { x: -4.5, z: -13, rotY: 0.95 };
const [trees, cabin] = await Promise.all([
  createTrees(terrain, 170, 45, [{ x: CABIN.x, z: CABIN.z, r: 7.5 }]),
  createCabin(terrain, CABIN),
]);
scene.add(trees.group);
scene.add(cabin.group);
snow.setCabinMask(cabin.snowMask); // под крышей снег не идёт

// единый реестр коллайдеров мира (формат — см. collide.js): деревья, дом,
// костёр; сюда же будущая стройка/мебель/враги. Динамические (дверь) живут
// как разделяемые объекты — их поля мутируются владельцем на месте.
const colliders = [...trees.obstacles, ...cabin.obstacles];

// костёр — очаг перед домом; он ЕСТ ДРОВА (затухает до углей без подброса)
const FIRE = { x: 2.5, z: -9 };
const campfire = new Campfire(scene, terrain, FIRE.x, FIRE.z);
colliders.push({ x: FIRE.x, z: FIRE.z, r: 0.85 });

// поленница у боковой стены дома (за углом от крыльца): запас дров, который
// ВИДНО, а не цифра. F у поленницы — взять полено (в руках, без бега),
// донести к костру, F у костра — подбросить. Штабель вдоль стены сруба
const woodpile = createWoodpile(terrain, 1.1, -16.8, CABIN.rotY + Math.PI / 2);
scene.add(woodpile.group);
colliders.push(woodpile.obstacle);

// брошенные поленья: F с поленом в руках (вне костра) — бросить перед собой,
// полено ляжет в снег и останется лежать; F рядом — поднять обратно
const groundLogs = new GroundLogs(scene);

// ---------- аудио, игрок, дыхание, статы ----------
const audio = new GameAudio();

// взгляд с телом: инерция мыши, крены в вираж/стрейф, клевок приземления,
// дыхание (look.js); ?rawlook — сырой 1:1 без эффектов
const look = new SmoothLook(camera, renderer.domElement);

const player = new Player(
  camera,
  look,
  terrain,
  (fx, fz, dir, side, running, surface) => {
    if (surface === 'snow') footprints.stamp(fx, fz, dir, side); // на досках следов нет
    audio.footstep(running, surface);
  },
  colliders,
  digger,
  (fx, fz) => cabin.floorHeightAt(fx, fz),
  (fx, fz, surface, impact) => {
    if (surface === 'snow') footprints.stampCircle(fx, fz, 0.45, 0.85); // вмятина от приземления
    audio.land(surface, Math.abs(impact));
    view.land(impact); // руки проседают вместе с телом
    look.land(impact); // и взгляд клюёт вниз
  }
);

const breath = new Breath(scene, camera, (exertion) => audio.breath(exertion));
const stats = new Stats();

// пар изо рта — ребёнок камеры (камера в сцене ради этого)
scene.add(camera);

// Всё, что в руках, живёт в слое viewmodel: своя камера с узким FOV и свой
// depth — предмет не растягивается у края кадра и не протыкает стены (viewmodel.js)
const view = new ViewModel(camera, moonDir);
const carriedLog = createCarriedLog();
carriedLog.position.z *= VIEW_Z; // компенсация узкого FOV — кадр остаётся прежним
view.add(carriedLog);

// лопата — воткнута в снег у поленницы. Ей копают (ЛКМ — срез-штык) и
// намывают (ПКМ — укладка); без лопаты в руках правок снега нет
const shovel = new Shovel(scene, view);
shovel.place(3.0, terrain.getHeight(3.0, -15.4), -15.4, 2.2);

// чужая жизнь: редкие цепочки звериных следов через поляну
const critters = new Critters(footprints, camera);

// память мира: копание, следы/тропы, костёр, позиция, лопата, поленья
// (сброс — кнопка в меню или ?reset)
const saver = new SaveGame({ digger, footprints, campfire, player, shovel, logs: groundLogs });
saver.load();
saver.start();
carriedLog.visible = player.carrying; // недонесённое полено пережило перезагрузку

// debug (?debug): доступ к системам из консоли — удобно щупать копание,
// подгонять зверей (__snow.critters.timer = 0) и жечь дрова (__snow.campfire.fuel = 0)
const freezes = []; // пойманные долгие кадры (ловец фризов в тике, только ?debug)
if (player.debug)
  window.__snow = {
    scene, camera, renderer, terrain, snowPatch, digger, player, cabin,
    campfire, critters, saver, audio, sky, footprints, stats, shovel, view, look, freezes,
  };

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

// сброс памяти мира: второе нажатие в течение 3.5 с — защита от случайного клика
const resetBtn = document.getElementById('resetWorld');
let resetArmedUntil = 0;
resetBtn.addEventListener('click', () => {
  if (performance.now() < resetArmedUntil) {
    saver.reset();
    return;
  }
  resetArmedUntil = performance.now() + 3500;
  resetBtn.textContent = 'точно? мир будет забыт';
  resetBtn.classList.add('arm');
  setTimeout(() => {
    resetArmedUntil = 0;
    resetBtn.textContent = 'начать ночь заново';
    resetBtn.classList.remove('arm');
  }, 3500);
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

// Копание — только лопатой в руках: ЛКМ — копнуть (срез-штык), ПКМ — уложить
// снег; кнопку можно держать — замахи идут цепочкой. Правка происходит
// в момент врезания штыка (см. shovel.update в тике).
// В ?debug остаётся старая сферическая кисть: мышь без лопаты и клавиши E/Q.
let digHeld = false;
let buildHeld = false;
renderer.domElement.addEventListener('mousedown', (e) => {
  if (!player.locked) return;
  if (e.button === 0) {
    if (shovel.held) digHeld = true;
    else if (player.debug) digger.editFromCamera(camera, -1);
  } else if (e.button === 2) {
    if (shovel.held) buildHeld = true;
    else if (player.debug) digger.editFromCamera(camera, +1);
  }
});
addEventListener('mouseup', (e) => {
  if (e.button === 0) digHeld = false;
  else if (e.button === 2) buildHeld = false;
});
addEventListener('blur', () => {
  digHeld = false;
  buildHeld = false;
});
renderer.domElement.addEventListener('contextmenu', (e) => e.preventDefault());
// поверхность под точкой: срез диггера → рельеф; пол/крыльцо домика — если выше
// (и брошенное полено, и воткнутая лопата встают на доски, а не тонут под них)
function groundAt(x, z) {
  let y = digger.surfaceBelow(x, z, player.pos.y + 1.2, player.pos.y - 3.5);
  if (y === null) y = terrain.getHeight(x, z);
  const fy = cabin.floorHeightAt(x, z);
  if (fy !== null && fy > y) y = fy;
  return y;
}

// F — контекстная «рука»: дверь / в огонь / бросить / взять по прицелу / воткнуть
addEventListener('keydown', (e) => {
  if (!player.locked) return;
  if (e.code === 'KeyE') {
    if (player.debug) digger.editFromCamera(camera, -1);
  } else if (e.code === 'KeyQ') {
    if (player.debug) digger.editFromCamera(camera, +1);
  } else if (e.code === 'KeyF') {
    if (nearDoor) {
      audio.door(cabin.toggleDoor());
      shadowDirty = true; // дверь — кастер; распахнутую створку дорисует таймер
    } else if (player.carrying && nearFire) {
      player.carrying = false;
      carriedLog.visible = false;
      campfire.addFuel();
      audio.fireFeed();
      shadowDirty = true;
    } else if (player.carrying) {
      // просто бросить: полено ляжет перед ногами и останется лежать
      player.carrying = false;
      carriedLog.visible = false;
      camera.getWorldDirection(_dirTmp);
      const lx = player.pos.x + _dirTmp.x * 0.7;
      const lz = player.pos.z + _dirTmp.z * 0.7;
      groundLogs.drop(lx, groundAt(lx, lz), lz, Math.atan2(_dirTmp.x, _dirTmp.z) + Math.PI / 2);
      audio.woodDrop();
      shadowDirty = true; // полено — новый кастер
    } else if (handTarget && handTarget.kind === 'shovel') {
      shovel.take();
      audio.shovelTake();
      shadowDirty = true; // воткнутая лопата исчезла из мира
      shovelHintT = 9; // короткая подсказка, что лопатой делать
    } else if (handTarget) {
      // поленница или лежащее полено — в руки
      if (handTarget.kind === 'log') {
        groundLogs.take(handTarget.ref);
        shadowDirty = true;
      }
      player.carrying = true;
      carriedLog.visible = true;
      audio.woodTake();
      carryHintT = 5; // подсказка, что полено можно просто бросить
    } else if (shovel.held && !shovel.busy) {
      // воткнуть перед собой — лопата остаётся стоять, где оставил
      camera.getWorldDirection(_dirTmp);
      const sx = player.pos.x + _dirTmp.x * 0.8;
      const sz = player.pos.z + _dirTmp.z * 0.8;
      shovel.plant(sx, groundAt(sx, sz), sz, Math.atan2(_dirTmp.x, _dirTmp.z) + 0.5);
      audio.shovelPlant();
      shadowDirty = true; // лопата встала в мир — новый кастер
    }
  }
});

// Прелоадер: прогрев шейдеров + проталина у костра. compile() обходит сцену
// БЕЗ frustum culling — компилирует и материалы вне стартового кадра.
// Один кадр composer'а этого не давал: после перезагрузки восстановленные ямы
// (digger) за спиной отсекались культингом, и их тяжёлый шейдер компилировался
// при ПЕРВОМ повороте к раскопу — сотни мс фриза (Windows/ANGLE). Теперь фриз
// оплачен здесь, под заставкой.
requestAnimationFrame(() => {
  renderer.compile(scene, camera);
  // чанки ям — кадр без отсечения: геометрия уезжает в GPU тоже под заставкой
  digger.group.traverse((o) => { o.frustumCulled = false; });
  composer.render();
  digger.group.traverse((o) => { o.frustumCulled = true; });
  view.render(renderer);
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
  view.setSize(window.innerWidth, window.innerHeight);
});

// ---------- цикл ----------
const clock = new THREE.Clock();
let fadeAcc = 0;
let meltAcc = 0;
let blizzard = 0; // 0..1 — сглаженная сила метели
let nearDoor = false; // рядом с дверью — работает F
let nearFire = false; // рядом с костром — F подбрасывает полено
let handTarget = null; // что возьмёт F: {kind:'pile'|'shovel'|'log', ref} — ближайшее к прицелу
let shovelHintT = 0; // сек показа подсказки после взятия лопаты
let carryHintT = 0; // сек показа подсказки «бросить полено»
let shadowAcc = 0; // таймер перерисовки карты теней
const _sRight = new THREE.Vector3(); // базис плоскости окна теней (⊥ лучу луны)
const _sUp = new THREE.Vector3();
let indoorK = 0; // 0..1 — сглаженное «мы в домике» (глушит ветер, греет)
let caveK = 0; // 0..1 — сглаженное «мы в вырытой пещере» (укрытие)
let caveTarget = 0;
let shelterAcc = 0;
const promptEl = document.getElementById('prompt');
const _toFire = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();
const _sprayDir = new THREE.Vector3();
const _aim = new THREE.Vector3();

// Ловец фризов (?debug): кадр дольше FREEZE_MS → в консоль уходит [FREEZE] —
// разбивка, где утонуло время (секции тика), и что дёрнулось в GL за рендер:
// шейдеров>0 — компилировалась программа, геом>0 — заливались новые VBO,
// теньКадр=1 — в этом кадре перерисовывалась карта теней. История — в
// __snow.freezes (в консоли: copy(__snow.freezes)).
const FREEZE_MS = 80;
const _fm = new Float64Array(8); // метки границ секций кадра

// Врезание штыка: правка снега + звук + брызги (зовёт shovel.update в момент
// удара). Возвращает, укусил ли штык снег: промах не отдаёт в камеру.
function onShovelImpact(kind) {
  const sign = kind === 'dig' ? -1 : +1;
  const p = digger.shovelEdit(camera, sign);
  if (!p) {
    audio.shovelWhiff();
    return false;
  }
  if (kind === 'dig') audio.shovelDig();
  else audio.shovelScoop();
  camera.getWorldDirection(_dirTmp);
  // при копке крошка летит на копающего и вверх; при укладке — вперёд от штыка
  _sprayDir.copy(_dirTmp).multiplyScalar(kind === 'dig' ? -0.7 : 0.5);
  _sprayDir.y = kind === 'dig' ? 1.3 : 0.7;
  shovel.spray(p, _sprayDir);
  return true;
}

// Пещера-укрытие: если над головой грунт, а вокруг стены — игрок в закрытом
// объёме. Сэмплы непрерывного SDF диггера (реже кадра — see shelterAcc).
// Выкопанная в метель нора глушит ветер УШАМИ — так игрок узнаёт, что построил
// укрытие, без единой надписи.
function sampleCave() {
  if (digger.edits.size === 0) return 0;
  const p = camera.position;
  const roof =
    digger.densityAt(p.x, p.y + 1.1, p.z) > 0 || digger.densityAt(p.x, p.y + 2.0, p.z) > 0;
  if (!roof) return 0;
  let solid = 0;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    if (digger.densityAt(p.x + Math.cos(a) * 1.7, p.y, p.z + Math.sin(a) * 1.7) > 0) solid++;
  }
  return 0.4 + 0.6 * (solid / 8);
}

function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const dbg = player.debug;
  if (dbg) _fm[0] = performance.now();

  sky.update(t); // луна ползёт по полярному кругу — ДО блока теней: снап в свежем базисе

  // Тени: окно карты ведём за игроком, перерисовка — по таймеру или событию.
  // Блок стоит ДО физики и лопаты: правка снега этого кадра лишь взводит dirty,
  // а перерисовка уходит в следующий — спайки remesh и теней не складываются.
  shadowAcc += dt;
  if (shadowAcc >= SHADOW_TIER.interval || shadowDirty) {
    shadowAcc = 0;
    shadowDirty = false;
    // снеп окна к целому текселю карты в плоскости, перпендикулярной лучу, —
    // иначе при перецентровке тени переползали бы на долю текселя каждый тик
    _sRight.set(0, 1, 0).cross(moonDir).normalize();
    _sUp.crossVectors(moonDir, _sRight);
    const texel = (SHADOW_HALF * 2) / SHADOW_TIER.size;
    const qx = Math.round(player.pos.dot(_sRight) / texel) * texel;
    const qy = Math.round(player.pos.dot(_sUp) / texel) * texel;
    moonLight.target.position
      .copy(_sRight).multiplyScalar(qx)
      .addScaledVector(_sUp, qy)
      .addScaledVector(moonDir, player.pos.dot(moonDir));
    renderer.shadowMap.needsUpdate = true;
  }
  // НАПРАВЛЕНИЕ света — за луной каждый кадр (позиция от цели окна теней, уже
  // обновлённой выше); сама карта теней перерисовывается реже — блоком выше
  moonLight.position.copy(moonDir).multiplyScalar(180).add(moonLight.target.position);
  if (dbg) _fm[1] = performance.now(); // ловец: конец секции неба/теней

  // метель: плавно следует за порывами ветра из аудио
  blizzard += (Math.max(0, audio.windLevel - 0.35) / 0.65 - blizzard) * Math.min(1, dt * 0.35);
  scene.fog.density = FOG_CALM + blizzard * (FOG_STORM - FOG_CALM);
  for (const m of ridges.mats) m.opacity = 1 - blizzard * 0.8;

  // взгляд — ДО физики: направление движения должно идти по свежей камере
  look.update(dt, player);
  player.update(dt);
  footprints.updateView(player.pos.x, player.pos.z); // окно детальной карты следов
  if (dbg) _fm[2] = performance.now(); // ловец: конец физики

  // лопата: пока кнопка удержана — замахи цепочкой, врезание внутри замаха
  if (shovel.held && (digHeld || buildHeld)) shovel.trySwing(digHeld ? 'dig' : 'build');
  shovel.update(dt, onShovelImpact);
  view.update(dt, player); // sway/bob/дыхание/просадка — общие для всего, что в руках
  if (dbg) _fm[3] = performance.now(); // ловец: конец лопаты/рук

  // пещера-укрытие: сэмплы SDF дороже кадра — обновляем цель ~5 раз/с
  shelterAcc += dt;
  if (shelterAcc > 0.2) {
    shelterAcc = 0;
    caveTarget = sampleCave();
  }
  caveK += (caveTarget - caveK) * Math.min(1, dt * 2.5);

  snowPatch.update(camera.position);
  snow.update(dt, t, camera.position, audio.windLevel, blizzard, caveK);
  aurora.update(t, blizzard);
  breath.update(dt, player.exertion, audio.windLevel);
  campfire.update(dt, t, audio.windLevel);
  cabin.update(t, dt);
  critters.update(dt);
  if (dbg) _fm[4] = performance.now(); // ловец: конец мировых систем

  // домик/пещера: глушение ветра внутри, тепло от печки
  const doorDist = camera.position.distanceTo(cabin.doorCenter);
  nearDoor = doorDist < 2.4;
  const inside = cabin.isInside(camera.position.x, camera.position.z);
  indoorK += ((inside ? 1 : 0) - indoorK) * Math.min(1, dt * 2.5);
  const shelter = Math.max(indoorK, caveK); // стены дома ИЛИ толща снега
  audio.setIndoor(shelter);
  const stoveDist = camera.position.distanceTo(cabin.stovePos);
  const stoveHeat = THREE.MathUtils.clamp(1 - (stoveDist - 0.9) / 3.4, 0, 1);
  const cabinHeat = indoorK * Math.max(0.45, stoveHeat * 0.95); // в доме тепло, у печки — жарко

  // тепло от костра (угли греют еле-еле — heatK) + позиционный звук
  _toFire.copy(campfire.position).sub(camera.position);
  const fireDist = Math.hypot(_toFire.x, _toFire.z);
  const fireHeat = THREE.MathUtils.clamp(1 - (fireDist - 1.2) / 3.5, 0, 1) * campfire.heatK;
  // в пещере не греет, но и не выдувает: небольшой пассивный бонус
  const heat = Math.max(fireHeat, cabinHeat, caveK * 0.22);
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  const pan = fireDist > 0.3 ? (_toFire.x * _camRight.x + _toFire.z * _camRight.z) / fireDist : 0;
  audio.updateCampfire(fireDist, pan, campfire.burnU.value);

  // цель контекстной руки: из досягаемого (поленница, лопата, брошенные
  // поленья) берём ближайшее К ПРИЦЕЛУ, а не по жёсткому приоритету —
  // лопата стоит у поленницы, и раньше F хватал полено, куда бы ты ни смотрел
  nearFire = fireDist < 2.4;
  handTarget = null;
  if (!player.carrying && !shovel.held) {
    let bestDot = -1;
    camera.getWorldDirection(_dirTmp);
    const consider = (kind, x, y, z, ref) => {
      _aim.set(x - camera.position.x, y - camera.position.y, z - camera.position.z);
      if (_aim.x * _aim.x + _aim.z * _aim.z > 1.9 * 1.9) return; // вне досягаемости
      const dot = _aim.normalize().dot(_dirTmp);
      if (dot > bestDot) {
        bestDot = dot;
        handTarget = { kind, ref };
      }
    };
    consider('pile', woodpile.position.x, woodpile.position.y + 0.4, woodpile.position.z);
    consider('shovel', shovel.pos.x, shovel.pos.y + 0.5, shovel.pos.z);
    for (const l of groundLogs.list) consider('log', l.x, l.y + 0.1, l.z, l);
  }
  if (shovel.held && shovelHintT > 0) shovelHintT -= dt;
  if (carryHintT > 0) carryHintT -= dt;
  let promptText = null;
  if (nearDoor) promptText = cabin.doorOpen ? 'F — закрыть дверь' : 'F — открыть дверь';
  else if (player.carrying && nearFire) promptText = 'F — подбросить в огонь';
  else if (player.carrying && carryHintT > 0) promptText = 'F — бросить полено';
  else if (handTarget)
    promptText = {
      pile: 'F — взять полено',
      shovel: 'F — взять лопату',
      log: 'F — поднять полено',
    }[handTarget.kind];
  else if (shovel.held && shovelHintT > 0)
    promptText = 'ЛКМ — копать · ПКМ — намыть · F — воткнуть';
  promptEl.classList.toggle('show', !!promptText && player.locked);
  if (promptText) promptEl.textContent = promptText;

  // укрытие спасает от ветра: тепло утекает как в штиль
  const effBliz = blizzard * (1 - 0.75 * shelter);
  stats.update(dt, effBliz, player, heat);
  // мороз в уши: скрип шагов и треск деревьев зависят от температуры
  audio.setTemperature(-10 - effBliz * 16 + heat * 22);

  // озноб замерзания: мелкая дрожь камеры — телесный сигнал вместо шкалы
  const chill = Math.max(0, (0.4 - stats.warmth) / 0.4);
  if (chill > 0.01 && !stats.dead) {
    const a = chill * chill * 0.013;
    camera.position.x += (Math.sin(t * 33.7) + Math.sin(t * 61.3 + 1.7)) * 0.5 * a;
    camera.position.y += (Math.sin(t * 41.9 + 0.7) + Math.sin(t * 27.3 + 2.1)) * 0.5 * a;
  }

  // снег постепенно заметает следы; проталина у костра живёт, пока он горит
  fadeAcc += dt;
  if (fadeAcc > 0.25) {
    fadeAcc = 0;
    footprints.fade();
  }
  meltAcc += dt;
  if (meltAcc > 3) {
    meltAcc = 0;
    footprints.stampCircle(FIRE.x, FIRE.z, 0.8 + 1.1 * campfire.burn, 0.09 * campfire.burn);
  }

  // Отдача от удара лопатой. Кладём её на камеру ровно на время кадра и снимаем
  // сразу после: SmoothLook пересобирает кватернион каждый кадр и в прицел punch
  // не утечёт, но viewmodel меряет угловую скорость взгляда по камере — оставленный
  // punch читался бы как рывок мыши. Дёргается мир — не viewmodel: он привязан
  // к виду, своя отдача у него в кейфреймах замаха.
  const { pitch, roll } = shovel.punch;
  let fzProg = 0, fzGeo = 0, fzTex = 0, fzShadow = false;
  if (dbg) {
    _fm[5] = performance.now(); // ловец: конец HUD/прочего, старт рендера
    fzProg = renderer.info.programs.length;
    fzGeo = renderer.info.memory.geometries;
    fzTex = renderer.info.memory.textures;
    fzShadow = renderer.shadowMap.needsUpdate; // карта теней перерисуется в этом кадре
  }
  camera.rotateX(pitch);
  camera.rotateZ(roll); // локальные оси: отдача не зависит от того, куда смотрим
  composer.render();
  camera.rotateZ(-roll);
  camera.rotateX(-pitch);
  if (dbg) _fm[6] = performance.now(); // ловец: конец основного рендера

  view.render(renderer); // руки — последним проходом, поверх мира и со своим depth

  if (dbg) {
    _fm[7] = performance.now();
    const total = _fm[7] - _fm[0];
    if (total > FREEZE_MS) {
      const inf = renderer.info;
      const r = {
        мс: Math.round(total),
        тени: +(_fm[1] - _fm[0]).toFixed(1),
        физика: +(_fm[2] - _fm[1]).toFixed(1),
        руки: +(_fm[3] - _fm[2]).toFixed(1),
        мир: +(_fm[4] - _fm[3]).toFixed(1),
        хад: +(_fm[5] - _fm[4]).toFixed(1),
        рендер: +(_fm[6] - _fm[5]).toFixed(1),
        вид: +(_fm[7] - _fm[6]).toFixed(1),
        шейдеров: inf.programs.length - fzProg,
        геом: inf.memory.geometries - fzGeo,
        текстур: inf.memory.textures - fzTex,
        теньКадр: fzShadow ? 1 : 0,
        yaw: Math.round((look.yaw * 180) / Math.PI),
        чанков: digger.chunks.size,
      };
      freezes.push(r);
      if (freezes.length > 30) freezes.shift();
      console.warn('[FREEZE]', JSON.stringify(r));
    }
  }
}
tick();
