import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { Terrain } from './terrain.js';
import { SnowPatch } from './snowpatch.js';
import { Digger } from './digger.js';
import { createCaves } from './caves.js';
import { WORLD_SEED } from './seed.js';
import { Footprints } from './footprints.js';
import { Sky } from './sky.js';
import { Snowfall } from './snowfall.js';
import { createTrees } from './trees.js';
import { createCabin } from './cabin.js';
import { createRidges } from './ridges.js';
import { Aurora } from './aurora.js';
import { Breath } from './breath.js';
import { Campfire } from './campfire.js';
import { GameAudio } from './audio.js';
import { Stats } from './stats.js';
import { Critters } from './critters.js';
import { Woodpile, createChoppingBlock, createCarriedLog, GroundLogs } from './firewood.js';
import { initSnowCap } from './snowcap.js';
import { Shovel, loadShovelModel } from './shovel.js';
import { Axe } from './axe.js';
import { Pickaxe } from './pickaxe.js';
import { Hammer } from './hammer.js';
import { Torch } from './torch.js';
import { Workbench } from './workbench.js';
import { Lumber } from './lumber.js';
import { SaveGame } from './save.js';
import { applyRecipe, buildAvoided } from './building.js';
import { applyRecipeAt } from './crafting.js';
import { RECIPES } from './data/recipes.js';
import { caveShelter, aimedAt } from './shelter.js';
import { ResourceYard, resourceName } from './resources.js';
import { Homestead } from './homestead.js';
import { visibility, nearestStructureSurface } from './interaction.js';
import { fitToolToAspect } from './hand-model.js';
import { createAwakening } from './awaken.js';
import { createSpread } from './spread.js';
import { createTouch, touchForced, touchSupported } from './touch.js';
import { createSupport } from './support.js';
import { Body, Input, SmoothLook, ViewModel, VIEW_Z } from 'world-core/core';
import { material } from 'world-core/materials';
import { createShell } from './shell.js';
import { keepOffline } from './offline.js';
import { matset, prepareMatsets } from './matsets.js';

// Вехи загрузки уходят в трассу boot.js: измерять её надо числами, а не
// секундомером у экрана (см. `__FTE_BOOT__.trace()`).
// Второй аргумент - подпись под полосой, и она человеческая: полоса
// рассказывает, что мир собирает сейчас, а не показывает имена внутренних
// шагов. Таблица живёт ЗДЕСЬ, а не в оболочке: вехи у каждого мира свои.
const STAGE = {
  'модуль разобран': 'ночь',
  'мир собран': 'поляна',
  'прогрев начат': 'снег',
  'изба собрана': 'изба',
  'лес собран': 'лес',
  'мебель на месте': 'тепло в избе',
  'мир одет': 'зима на месте',
};
const mark = (n) => window.__FTE_BOOT__?.mark(n, STAGE[n]);
mark('модуль разобран');
const bootBreathe = createSpread();

// ---------- прогресс заставки ----------
// Саму полосу ведёт `boot.js`: он знает и ход по вехам, и вот эти доли, и
// берёт из них большее. Отсюда уходит только доля загрузчика - один общий
// DefaultLoadingManager обслуживает и glTF, и текстуры, так что счёт покрывает
// всю загрузку мира до первого кадра.
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  if (!total) return;
  window.__FTE_BOOT__?.progress(loaded / total);
};

// ---------- рендерер ----------
// Автоматический ярус можно переопределить через ?quality=high|medium|low.
// Отдельный ?shadows=... сохранён для замеров карты теней.
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const memory = navigator.deviceMemory || 4;
const cores = navigator.hardwareConcurrency || 4;
const coarse = matchMedia('(pointer: coarse)').matches;
const requestedQuality = params.get('quality');
const autoQuality =
  reducedMotion || memory <= 2 || cores <= 2
    ? 'low'
    : coarse || memory <= 4 || cores <= 4 || devicePixelRatio > 1.75
      ? 'medium'
      : 'high';
const qualityName = ['high', 'medium', 'low'].includes(requestedQuality)
  ? requestedQuality
  : autoQuality;
const QUALITY = {
  high: { dpr: 1.75, shadow: 'high', bloom: 0.45 },
  medium: { dpr: 1.35, shadow: 'medium', bloom: 0.38 },
  low: { dpr: 1, shadow: 'low', bloom: 0.28 },
}[qualityName];

const SHADOW_TIER =
  {
    high: { size: 2048, soft: true, interval: 0.25 },
    medium: { size: 1024, soft: false, interval: 0.5 },
    low: { size: 512, soft: false, interval: 1.0 },
  }[params.get('shadows') || QUALITY.shadow];
const SHADOW_HALF = 38; // полуразмер окна карты теней вокруг игрока, м

// При EffectComposer MSAA сглаживает только финальный quad и зря держит
// дополнительный буфер. Края смягчаются постобработкой и разрешением яруса.
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
// В проде ошибки шейдеров ловит сборка. Синхронное чтение логов у каждого
// первого использования ждало SwiftShader и держало поток больше секунды.
renderer.debug.checkShaderErrors = false;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY.dpr));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = SHADOW_TIER.soft ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false; // взводим needsUpdate сами (см. блок теней в тике)
// Первый кадр скрыт плотной пеленой. Карту теней строит первая порция
// прогрева сразу после ready, когда это уже не задерживает кнопки входа.
renderer.shadowMap.needsUpdate = false;
let shadowDirty = false; // событие изменило кастеры → перерисовать тень в следующем кадре
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
document.body.appendChild(renderer.domElement);
await bootBreathe();

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
await bootBreathe();
const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
await bootBreathe();
await prepareMatsets('surfaceSnow');
const terrain = new Terrain(footprints, maxAnisotropy);
scene.add(terrain.mesh);
await bootBreathe();

// снежные шапки (крыша, дрова) берут те же текстуры снега, что земля и раскоп —
// вещество едино по всему миру; задаём до создания сруба/поленницы
initSnowCap(terrain.textures);

// деформируемый снег вокруг игрока
const snowPatch = new SnowPatch(footprints, terrain);
scene.add(snowPatch.mesh);

// Поле природных пещер от семени мира. Цилиндры avoid - места, под которыми
// грунт обязан остаться целым: изба, костёр и стартовая площадка (провалиться
// под избу в первую же минуту - не то знакомство с миром). Координаты избы и
// костра объявлены ниже по файлу, поэтому здесь они повторены числами: это
// единственное место, где такое повторение есть, и его стережёт тест avoid.
const caves = createCaves({
  seed: WORLD_SEED,
  avoid: [
    { x: -4.5, z: -13, r: 9 }, // изба (CABIN)
    { x: 2.5, z: -9, r: 6 }, // костёр (FIRE)
    { x: 0, z: 0, r: 14 }, // стартовая площадка
  ],
});
const buildAvoid = caves.avoid.slice(0, 2); // для стройки закрыты изба и костёр

// воксельное копание (Digger): реальный 3D-объём — ямы, тоннели, пещеры
const digger = new Digger(scene, terrain, snowPatch, footprints, caves);
// Геометрия и её тень должны появляться в одном кадре: старая карта теней
// поверх нового выреза даёт тёмную вспышку по квадрату колонки.
digger.onChanged = () => { renderer.shadowMap.needsUpdate = true; };
await bootBreathe();

const sky = new Sky(moonDir);
scene.add(sky.group);

const ridges = createRidges();
scene.add(ridges.group);

const aurora = new Aurora(Math.atan2(-moonDir.x, -moonDir.z));
scene.add(aurora.mesh);

const snow = new Snowfall();
scene.add(snow.points);

const CABIN = { x: -4.5, z: -13, rotY: 0.95 };
const FIRE = { x: 2.5, z: -9 };
// ---------- постобработка ----------
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  QUALITY.bloom,
  0.65,
  0.82
);
composer.addPass(bloom);
const output = new OutputPass();
// OutputPass выставляет эти два define при первом render. Задаём их до
// фоновой компиляции, чтобы первый настоящий кадр не создавал второй вариант.
output.material.defines = { SRGB_TRANSFER: '', ACES_FILMIC_TONE_MAPPING: '' };
output._outputColorSpace = renderer.outputColorSpace;
output._toneMapping = renderer.toneMapping;
composer.addPass(output);

const postScene = new THREE.Scene();
const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const postGeometry = new THREE.PlaneGeometry(2, 2);
const postMaterials = [
  composer.copyPass.material,
  bloom.basic,
  bloom.materialHighPassFilter,
  ...bloom.separableBlurMaterials,
  bloom.compositeMaterial,
  bloom.blendMaterial,
  output.material,
];
for (const material of postMaterials) postScene.add(new THREE.Mesh(postGeometry, material));

// compileAsync ждёт линковку программ без синхронной остановки JavaScript.
// Рендер-таргет совпадает с композером, поэтому ключи программ тоже совпадают.
function compileSceneAsync(settleMs = 100) {
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  const compiling = renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(previous);
  // SwiftShader не отдаёт KHR_parallel_shader_compile. Three в этом случае
  // ждёт лишь один таймер на 10 мс и считает программу готовой, а первое
  // чтение uniform-полей затем синхронно ждёт линковку сотни миллисекунд.
  // Даём драйверу закончить её в фоне, пока главный поток свободен.
  const settled = new Promise((resolve) => setTimeout(resolve, settleMs));
  return Promise.all([compiling, settled]);
}

async function compileObjectsAsync(objects, settleMs = 100) {
  const settled = new Promise((resolve) => setTimeout(resolve, settleMs));
  const compilations = [];
  let sliceStarted = performance.now();
  for (let at = 0; at < objects.length; at += 8) {
    const compileScene = new THREE.Scene();
    compileScene.fog = scene.fog;
    scene.traverse((object) => {
      if (object.isLight) compileScene.add(object.clone(false));
    });
    for (const object of objects.slice(at, at + 8)) {
      const copy = object.clone(false);
      copy.visible = true;
      copy.frustumCulled = false;
      compileScene.add(copy);
      if (!object.castShadow) continue;
      const source = Array.isArray(object.material) ? object.material : [object.material];
      const depth = object.customDepthMaterial
        ? source.map(() => object.customDepthMaterial)
        : source.map((material) => {
          const derived = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
          derived.map = material.map;
          derived.alphaMap = material.alphaMap;
          derived.alphaTest = material.alphaTest;
          derived.displacementMap = material.displacementMap;
          derived.displacementScale = material.displacementScale;
          derived.displacementBias = material.displacementBias;
          derived.side = material.side === THREE.FrontSide
            ? THREE.BackSide
            : material.side === THREE.BackSide ? THREE.FrontSide : THREE.DoubleSide;
          return derived;
        });
      const shadowCopy = object.clone(false);
      shadowCopy.material = Array.isArray(object.material) ? depth : depth[0];
      shadowCopy.visible = true;
      shadowCopy.frustumCulled = false;
      compileScene.add(shadowCopy);
    }
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(composer.readBuffer);
    compilations.push(renderer.compileAsync(compileScene, camera));
    renderer.setRenderTarget(previous);
    if (performance.now() - sliceStarted >= PROGRAM_BUDGET_MS) {
      await nextTask();
      sliceStarted = performance.now();
    }
  }
  await Promise.all([...compilations, settled]);
}

function compilePostAsync(settleMs = 800) {
  const previous = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  const compiling = renderer.compileAsync(postScene, postCamera);
  renderer.setRenderTarget(previous);
  const settled = new Promise((resolve) => setTimeout(resolve, settleMs));
  return Promise.all([compiling, settled]);
}

const reflectedPrograms = new Set();
const PROGRAM_BUDGET_MS = 12;
async function reflectProgramsAsync(programs) {
  let sliceStarted = performance.now();
  for (const program of programs) {
    if (reflectedPrograms.has(program)) continue;
    reflectedPrograms.add(program);
    const reflectStarted = performance.now();
    program.getUniforms();
    console.log('reflect', program.id, program.name, program.type, Math.round(performance.now() - reflectStarted));
    // Готовые программы читаются за единицы миллисекунд. Отдаём кадр только
    // когда их сумма исчерпала бюджет, а не перед каждой программой.
    if (performance.now() - sliceStarted >= PROGRAM_BUDGET_MS) {
      await nextFrame();
      sliceStarted = performance.now();
    }
  }
}

async function reflectSceneProgramsAsync(root = scene) {
  const programs = new Set();
  const priorities = new Map();
  root.traverse((object) => {
    if (!object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      const program = renderer.properties.get(material).currentProgram;
      if (program && !reflectedPrograms.has(program)) {
        programs.add(program);
        const key = material.customProgramCacheKey?.() || '';
        let priority = material.isShaderMaterial || material.isMeshBasicMaterial ? 0 : 1;
        if (key === 'snow-patch') priority = 2;
        if (key === 'snow-base-light') priority = 3;
        priorities.set(program, Math.max(priorities.get(program) || 0, priority));
      }
    }
  });
  const ordered = [...programs].sort((a, b) => priorities.get(a) - priorities.get(b));
  await reflectProgramsAsync(ordered);
}

async function reflectRendererProgramsAsync() {
  await reflectProgramsAsync(renderer.info.programs || []);
}

const primedTextures = new Set();
async function primeSceneTexturesAsync(root = scene, include = () => true) {
  const textures = new Set();
  root.traverse((object) => {
    if (!object.material || !include(object)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(material.uniforms || {})) {
        if (uniform.value?.isTexture) textures.add(uniform.value);
      }
    }
  });
  let sliceStarted = performance.now();
  for (const texture of textures) {
    if (primedTextures.has(texture)) continue;
    const image = texture.source?.data;
    // Внешняя картинка могла ещё ехать. Её загрузчик сам подхватит позже,
    // а пустой image нельзя считать загруженной текстурой.
    if (image && 'complete' in image && !image.complete) continue;
    primedTextures.add(texture);
    renderer.initTexture(texture);
    if (performance.now() - sliceStarted >= PROGRAM_BUDGET_MS) {
      await nextFrame();
      sliceStarted = performance.now();
    }
  }
}

// Костёр горит с первого кадра, поэтому его настоящий источник заводим до
// первой компиляции.
const campfire = new Campfire(scene, terrain, FIRE.x, FIRE.z);

// В избе четыре окна, два источника топки, свеча и фонарь. Изба приезжает
// позднее, но число источников PBR должно быть постоянным с первой компиляции.
// Нулевые слоты заменяются реальными источниками одним изменением сцены.
const cabinLightSlots = [
  ...Array.from({ length: 4 }, () => new THREE.PointLight(0xffa550, 4.5, 7.5, 2)),
  new THREE.PointLight(0xff8a40, 2.6, 8.5, 2),
  new THREE.PointLight(0xff6a24, 1.5, 1.9, 2),
  new THREE.PointLight(0xffc070, 1.15, 4, 2),
  new THREE.PointLight(0xffb060, 2.2, 8, 2),
];
for (const light of cabinLightSlots) {
  light.intensity = 0;
  scene.add(light);
}

// Самый тяжёлый снежный шейдер начинает собираться, пока приезжают карты дров
// и открывается хранилище сохранения. На повторном входе программы уже есть в
// кэше драйвера, поэтому холодная страховочная пауза не нужна.
const warmEntry = navigator.serviceWorker?.controller != null;
const coreSceneCompiled = compileSceneAsync(warmEntry ? 100 : 900)
  .then(() => reflectSceneProgramsAsync());
const postProgramsCompiled = compilePostAsync(warmEntry ? 100 : 800)
  .then(() => reflectSceneProgramsAsync(postScene));
const coreDrawables = new Set();
scene.traverse((object) => {
  if (object.isMesh || object.isPoints || object.isLine) coreDrawables.add(object);
});
const coreSceneRoots = new Set(scene.children);
const coreTexturesPrimed = coreSceneCompiled
  .then(() => primeSceneTexturesAsync(scene, (object) => coreDrawables.has(object)));
await bootBreathe();

// ---------- то, что приезжает по сети ----------
// Домик с тёплыми окнами и лес (сосны LOLIPOP, камни Quaternius) — четыре
// мегабайта на двоих, и раньше мир ждал их здесь, top-level await'ом. Ждал
// целиком: полоса загрузки стояла до последней книги на столе ВНУТРИ избы,
// которую со старта не видно вовсе.
//
// Теперь мир собирается до конца без сети — на том, что считается кодом, — и
// зовёт игрока внутрь по первому кадру. Изба и лес приезжают следом, волной
// отделки (она в конце файла, там же и порядок). Отсюда до неё живут три
// вещи, которые эту отсрочку и делают возможной.

// Первая: реестр коллайдеров (формат — см. collide.js) ЖИВОЙ и поначалу
// пустой. Игрок и рубка держат на этот массив ссылку, поэтому дописанное
// волной видно им сразу, без пересборки. Динамические препятствия (дверь)
// живут как разделяемые объекты — их поля мутируются владельцем на месте.
const colliders = [];

// Вторая: пустая изба. Тик спрашивает избу каждый кадр — про дверь, про пол,
// про печку, — и десяток проверок на null в горячем пути был бы худшим
// решением и для читаемости, и для скорости. Вместо этого место избы держит
// пустышка с тем же набором вопросов и честными ответами «избы тут нет».
// Дверь и печка у неё унесены на километр вниз: ни подсказки, ни тепла с
// такого расстояния не бывает, и отдельного условия для этого не нужно.
const FAR_AWAY = new THREE.Vector3(0, -1000, 0);
const NO_CABIN = {
  group: null,
  obstacles: [],
  snowMask: null,
  doorOpen: false,
  doorCenter: FAR_AWAY,
  stovePos: FAR_AWAY,
  update() {},
  toggleDoor() { return false; },
  floorHeightAt: () => null,
  isInside: () => false,
  heatK: 0,
  fuel: 0,
};
let cabin = NO_CABIN;

// Третья: лес до приезда - просто отсутствие леса. Рубка заводится с пустым
// списком сосен и принимает его волной (`setForest` в lumber.js), а сама
// ссылка держится ради отладочного хендла.
let trees = null;

// костёр — очаг перед домом; он ЕСТ ДРОВА (затухает до углей без подброса)
colliders.push({ x: FIRE.x, z: FIRE.z, r: 0.85 });

// Дрова входят в первый кадр, но их карты считает отдельный поток.
await prepareMatsets('bark', 'logend', 'split', 'floor', 'beam');

// поленница у боковой стены дома (за углом от крыльца): запас дров, который
// ВИДНО, а не цифра — и он КОНЕЧЕН. F у поленницы — взять полено (в руках,
// без бега), донести к костру, F у костра — подбросить. Принесённое из леса
// полено кладётся обратно по F — штабель растёт. Куча = счётчик (VISION.md)
const woodpile = new Woodpile(terrain, 1.1, -16.8, CABIN.rotY + Math.PI / 2);
scene.add(woodpile.group);
colliders.push(woodpile.obstacle);

// колода для колки рядом с поленницей — в ней ждёт топор
const block = createChoppingBlock(terrain, 2.1, -17.9);
scene.add(block.mesh);
colliders.push(block.obstacle);

// брошенные поленья: F с поленом в руках (вне костра) — бросить перед собой,
// полено ляжет в снег и останется лежать; F рядом — поднять обратно
const groundLogs = new GroundLogs(scene);

// Верстак стоит у боковой стены рядом с хозяйственным углом, но не пересекает
// поленницу, колоду и оставленные инструменты.
const workbench = new Workbench(terrain);
scene.add(workbench.group);
colliders.push(workbench.obstacle);
const yard = new ResourceYard(scene, (x, z) => terrain.getHeight(x, z));
colliders.push(...yard.obstacles);
const homestead = new Homestead(scene, {
  groundAt: (x, z) => digger.surfaceBelow(x, z, terrain.getHeight(x, z) + 1.2,
    terrain.getHeight(x, z) - 30) ?? terrain.getHeight(x, z),
  avoid: buildAvoid,
  obstacles: () => colliders,
});

// ---------- аудио, игрок, дыхание, статы ----------
const audio = new GameAudio();

// debug-режим (?debug): без экрана входа и без pointer lock, поворот стрелками
const debug = new URLSearchParams(location.search).has('debug');

// Контроллер от первого лица — общий для миров (world-core/core): взгляд с
// телом, слой ввода и само тело. Мир отдаёт ему только свою форму (support.js)
// и числа, которыми эта походка отличается от чужой.
//
// взгляд с телом: инерция мыши, крены в вираж/стрейф, клевок приземления,
// дыхание; ?rawlook — сырой 1:1 без эффектов
const look = new SmoothLook(camera, renderer.domElement);

// ввод: клавиши, мышь и палец сводятся в одно намерение. F и кнопки мыши
// уходят колбэками — что ими делать, знает только этот мир
const input = new Input({
  look,
  target: renderer.domElement,
  onAction: () => doHandAction(),
  onTool: (slot, down) => setToolHeld(slot, down),
  arrowTurn: debug,
});
input.free = debug; // без захвата курсора тело всё равно должно идти

const player = new Body({
  camera,
  input,
  support: createSupport({
    terrain,
    digger,
    colliders,
    getFloor: (fx, fz) => {
      const cabinY = cabin.floorHeightAt(fx, fz);
      const builtY = homestead.floorHeightAt(fx, fz, player.pos.y + 0.4);
      return cabinY === null ? builtY : builtY === null ? cabinY : Math.max(cabinY, builtY);
    },
    structure: homestead,
  }),
  spawn: new THREE.Vector3(0, terrain.getHeight(0, 0), 0),
  onStep: (fx, fz, dir, side, running, surface) => {
    if (surface === 'snow') footprints.stamp(fx, fz, dir, side); // на досках следов нет
    audio.footstep(running, surface);
  },
  onLand: (fx, fz, surface, impact) => {
    if (surface === 'snow') footprints.stampCircle(fx, fz, 0.45, 0.85); // вмятина от приземления
    audio.land(surface, Math.abs(impact));
    view.land(impact); // руки проседают вместе с телом
    look.land(impact); // и взгляд клюёт вниз
  },
});

const breath = new Breath(scene, camera, (exertion) => audio.breath(exertion));
const stats = new Stats();

// пар изо рта — ребёнок камеры (камера в сцене ради этого)
scene.add(camera);

// Всё, что в руках, живёт в слое viewmodel: своя камера с узким FOV и свой
// depth — предмет не растягивается у края кадра и не протыкает стены (world-core/core)
const view = new ViewModel(camera, { keyDir: moonDir });

view.add(yard.carried);

const carriedLog = createCarriedLog();
carriedLog.position.z *= VIEW_Z; // компенсация узкого FOV — кадр остаётся прежним
view.add(carriedLog);

// лопата — воткнута в снег у поленницы. Ей копают (ЛКМ — срез-штык) и
// намывают (ПКМ — укладка); без лопаты в руках правок снега нет.
// Модель раньше ждали здесь, чтобы лопата не стояла первые кадры невидимой.
// Теперь она едет волной отделки вместе с избой: `buildShovel` отдаёт пустую
// группу сразу, а приехавшая модель сама разойдётся по уже собранным копиям
// (см. `waiting` в shovel.js).
loadShovelModel();
const shovel = new Shovel(scene, view);
shovel.place(3.0, terrain.getHeight(3.0, -15.4), -15.4, 2.2);

// топор — воткнут в колоду. Им валят сосны (ЛКМ) и разделывают лежащие
// стволы на поленья; рубка — единственный способ пополнить поленницу
const axe = new Axe(scene, view);
axe.place(block.x, block.topY, block.z, 2.6);

// Кирка ждёт рядом с лопатой у избы, но их силуэты не пересекаются.
const pickaxe = new Pickaxe(scene, view);
pickaxe.place(4.2, terrain.getHeight(4.2, -16.2), -16.2, 2.35);

// Факел - четвёртый инструмент, он появляется в руках из инвентаря после крафта.
const torch = new Torch(scene, view);
// Молот - пятый инструмент, лежит у верстака.
const hammer = new Hammer(scene, view);
hammer.place(0.75, terrain.getHeight(0.75, -19.55), -19.55, 2.2);

// рубка леса: удары, дрожь кроны, валка, лежащие стволы, разделка (lumber.js)
// Лес приезжает волной отделки, поэтому рубка заводится пустой: до приезда
// топору просто не во что попасть (`setForest` в lumber.js).
const lumber = new Lumber([], colliders, groundLogs, {
  audio,
  footprints,
  dust: axe.dust, // снежная пыль рухнувшей кроны — та же система, что у зарубки
  groundAt: (x, z) => groundAt(x, z),
  avoid: [
    { x: CABIN.x, z: CABIN.z, r: 9 }, // крона не должна лечь на дом
    { x: FIRE.x, z: FIRE.z, r: 3.5 }, // и в костёр
  ],
  onCrash(dist) {
    // земля вздрагивает: чем ближе рухнуло, тем ощутимее толчок в ноги и взгляд
    const imp = 5 / (1 + dist * 0.4);
    view.land(imp);
    look.land(imp);
    shadowDirty = true;
  },
});

// чужая жизнь: редкие цепочки звериных следов через поляну
const critters = new Critters(footprints, camera);

// память мира: копание, следы/тропы, костёр, позиция, лопата, топор, кирка,
// поленья, поленница, сваленные деревья (сброс — кнопка в меню или ?reset)
const saver = new SaveGame({
  digger, footprints, campfire, player, shovel, logs: groundLogs,
  axe, pickaxe, hammer, torch, woodpile, lumber, yard, homestead,
});
saver.onMined = (kind, p) => {
  const dx = player.pos.x - p.x, dz = player.pos.z - p.z;
  const distance = Math.max(0.01, Math.hypot(dx, dz));
  const x = p.x + dx / distance * 0.5, z = p.z + dz / distance * 0.5;
  yard.drop(kind, new THREE.Vector3(x, groundAt(x, z), z));
  shadowDirty = true;
};
lumber.deps.onTimber = (x, y, z, yaw) => yard.drop('timber', new THREE.Vector3(x, y, z), yaw);
let wildlife = null;
// Предметы переднего плана не нужны за плотной пеленой первого кадра. Они
// входят в порционный прогрев сразу после ready и не мешают линковке поляны.
for (const object of scene.children) {
  if (!coreSceneRoots.has(object) && object.visible) {
    object.userData.bootDeferredRoot = true;
    object.visible = false;
  }
}
const returning = await saver.load();
saver.start();
// Вернувшийся мог выйти из мира, стоя на полу избы, а изба едет волной
// отделки. До её приезда пола под ним нет - держим его на месте
// (см. «опора, которой ещё нет» в теле ядра, world-core/core).
if (returning) {
  player.holdY = player.pos.y;
  // Камера переезжает к телу СРАЗУ, а не на последнем кадре пробуждения:
  // весь вход вернувшийся смотрит уже с того места, где вышел из мира.
  player.syncCamera();
}
carriedLog.visible = player.carryKind === 'log';
yard.update(saver.inventory, player.carryKind, torch.held);
// Old pocket logs become a visible pile; keep the single carried log.
for (let n = saver.inventory.count('log') - (player.carryKind === 'log' ? 1 : 0); n > 0; n--) {
  if (woodpile.count < woodpile.capacity) woodpile.add();
  else groundLogs.drop(2, terrain.getHeight(2, -17), -17, 0);
  saver.inventory.take('log', 1);
  saver.notePile(woodpile.count);
}

// debug (?debug): доступ к системам из консоли — удобно щупать копание,
// подгонять зверей (__snow.critters.timer = 0) и жечь дрова (__snow.campfire.fuel = 0)
const freezes = []; // пойманные долгие кадры (ловец фризов в тике, только ?debug)
if (debug)
  window.__snow = {
    scene, camera, renderer, terrain, snowPatch, digger, player, input,
    // поле пещер: __snow.caves.exits - выходы наверх, к ним удобно телепортироваться
    caves,
    campfire, critters, saver, audio, sky, footprints, stats, shovel, view, look, freezes,
    axe, pickaxe, hammer, torch, workbench, lumber, woodpile, groundLogs, yard, homestead,
    get wildlife() { return wildlife; },
    get handTarget() { return handTarget; },
    get buildTarget() { return buildTarget; },
    get shelter() { return { caveK, indoorK }; },
    action: () => doHandAction(),
    inventory: saver.inventory,
    // журнал мира: `__snow.journal.stats()` — сколько записей, байт, как въехал
    journal: saver.journal,
    // Сдвинуть мир в прошлое и перезагрузиться: так живой мир (growth.js)
    // проверяется без ожидания суток. Порядок ручной проверки описан у
    // SaveGame.timeTravel.
    timeTravel: (hours) => saver.timeTravel(hours),
    // Пробуждение создаётся ниже по файлу, вместе с заставкой, — геттером,
    // иначе обращение здесь пришлось бы на временную мёртвую зону `const` и
    // роняло бы весь отладочный хендл, а с ним и мир.
    get awakening() { return awakening; },
    // Изба и лес приезжают волной отделки — геттерами, иначе в консоли навсегда
    // осталось бы то, что лежало здесь в момент сборки: пустышка и null.
    get cabin() { return cabin; },
    get trees() { return trees; },
  };

// ---------- оболочка мира ----------
// Вход, пауза и выход на витрину — общий для всех миров экран (shell.js).
// Esc браузер обрабатывает сам: он отпускает курсор, а по этому событию
// возвращается экран паузы.
//
// Экран этот показан с первой секунды и мира не ждёт, но КНОПОК на нём до
// готовности мира нет вовсе: пока идёт загрузка, там только титул, строка
// настроения и полоса. Кнопки проступают вместе с расходящимся туманом, и
// сюда они переходят по `shell.ready()`.
function enterWorld(ev) {
  if (saver.status !== 'ok') return;
  // Вход - это конец ожидания, чем бы ни была занята отделка: за туманом
  // игрока оставлять нельзя. Если мир успел одеться сам, здесь пусто.
  unveilWorld();
  audio.init();
  audio.resume();
  // Появление мира запускается САМИМ нажатием, а не захватом курсора.
  // Сперва оно висело на событии `lock` — и это было ошибкой сразу дважды: на
  // телефоне pointer lock не запрашивается вовсе (ниже видно: там просто
  // `shell.close()`), а на десктопе браузер держит защитную паузу около
  // секунды после выхода по Esc и в захвате отказывает. В обоих случаях мир
  // остался бы тёмным и неуправляемым.
  awakening.enter();
  // Чем вошли, тем и играем. Раньше выбор шёл по факту «тач вообще возможен»,
  // а `'ontouchstart' in window` истинно на любом ноутбуке с сенсорным
  // экраном: там мир уходил в тач-режим, pointer lock не запрашивался
  // никогда — и мышь не могла повернуть взгляд вовсе. Спрашиваем само
  // нажатие: палец это был или мышь. Синтетический клик (Enter с клавиатуры)
  // pointerType не несёт — тогда решает тип указателя устройства.
  const byFinger = touchForced() || (ev && ev.pointerType
    ? ev.pointerType !== 'mouse'
    : matchMedia('(pointer: coarse)').matches);
  if (touch && byFinger) {
    touch.activate(); // на таче pointer lock нет — просто входим
    shell.close();
  } else requestMouse();
}

// Отказ браузера оставляет доступное меню. Повторное нажатие всегда может
// запросить курсор заново, а игра не остаётся за скрытым экраном без ввода.
function mouseDenied() {
  if (!document.pointerLockElement && !touch?.active && !stats.dead) shell.open();
}
function requestMouse() {
  try {
    const pending = renderer.domElement.requestPointerLock();
    pending?.catch(mouseDenied);
  } catch (e) { mouseDenied(); }
}
document.addEventListener('pointerlockerror', mouseDenied);

// сброс памяти мира: второе нажатие в течение 3.5 с — защита от случайного клика
const resetBtn = document.getElementById('resetWorld');
let resetArmedUntil = 0;
function armReset() {
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
}

const shell = createShell({ onEnter: enterWorld, onReset: armReset });

look.addEventListener('lock', () => {
  shell.close();
  audio.resume();
});
look.addEventListener('unlock', () => {
  // Замёрзшего экран паузы не встречает: у смерти свой экран со своей кнопкой.
  if (!stats.dead) shell.open();
});

// Копание — только лопатой в руках: ЛКМ — копнуть (срез-штык), ПКМ — уложить
// снег; кнопку можно держать — замахи идут цепочкой. Правка происходит
// в момент врезания штыка (см. shovel.update в тике).
let digHeld = false;
let buildHeld = false;
let chopHeld = false; // ЛКМ с топором — цепочка ударов, как копание лопатой
let timberHeld = false;
let mineHeld = false; // ЛКМ с киркой - цепочка коротких ударов
// Слот кнопки в замах переводит мир, а не ввод: ядру всё равно, что за
// инструмент в руках. Один и тот же обработчик обслуживает мышь и палец —
// кнопка на экране это те же ЛКМ и ПКМ.
function setToolHeld(slot, down) {
  if (slot === 1) {
    digHeld = down && shovel.held;
    chopHeld = down && !shovel.held && axe.held;
    mineHeld = down && !shovel.held && !axe.held
      && (pickaxe.held || hammer.held);
  } else {
    buildHeld = down && shovel.held;
    timberHeld = down && axe.held;
  }
  // The stroke records its purpose on press, even if released before impact.
  if (down && axe.held) axe.trySwing(slot === 2 ? 'timber' : 'chop');
}
// поверхность под точкой: срез диггера → рельеф; пол/крыльцо домика — если выше
// (и брошенное полено, и воткнутая лопата встают на доски, а не тонут под них)
function groundAt(x, z) {
  let y = digger.surfaceBelow(x, z, player.pos.y + 1.2, player.pos.y - 3.5);
  if (y === null) y = terrain.getHeight(x, z);
  const fy = cabin.floorHeightAt(x, z);
  if (fy !== null && fy > y) y = fy;
  const built = homestead.floorHeightAt(x, z, player.pos.y + 0.4);
  if (built !== null && built > y) y = built;
  return y;
}

// F (и тач-кнопка «рука») — контекстное действие: дверь / в огонь / сложить
// в штабель / бросить / взять по прицелу / воткнуть инструмент
function setCarry(kind = null) {
  player.carryKind = kind;
  player.carrying = !!kind;
  carriedLog.visible = kind === 'log';
  yard.update(saver.inventory, kind, torch.held);
}

function dropPoint(distance = 0.85) {
  camera.getWorldDirection(_dirTmp);
  const horizontal = _dirTmp.clone(); horizontal.y = 0;
  if (horizontal.lengthSq() > 0.01) {
    horizontal.normalize();
    const origin = player.pos.clone().add(new THREE.Vector3(0, 0.5, 0));
    const hit = nearestStructureSurface({
      getWorldPosition: out => out.copy(origin),
      getWorldDirection: out => out.copy(horizontal),
    }, [cabin.group, homestead.group], distance);
    if (hit) distance = Math.max(0.1, hit.distance - 0.22);
  }
  const x = player.pos.x + horizontal.x * distance;
  const z = player.pos.z + horizontal.z * distance;
  return new THREE.Vector3(x, groundAt(x, z), z);
}

function torchPlacement(surface) {
  const hit = nearestStructureSurface(camera, [cabin.group, homestead.group]);
  let point = surface?.point, normal = surface?.normal;
  if (hit && (!point || hit.distance < camera.position.distanceTo(point))) {
    point = hit.point;
    normal = hit.normal;
  }
  // A stake stands in the surface it reaches, including wooden floors.
  if (!point || normal.y < 0.55) return null;
  return point.clone().addScaledVector(normal, 0.015);
}

function doHandAction() {
  if (!player.locked || saver.blocked || stats.dead) return;
  const kind = player.carryKind;
  const target = handTarget;
  if (nearDoor) {
    audio.door(cabin.toggleDoor());
    shadowDirty = true;
    return;
  }
  if (kind === 'log' && (nearFire || nearHearth)) {
    const fire = nearHearth ? cabin : campfire;
    if (fire.fuel >= 1) return;
    fire.addFuel();
    saver.inventory.take('log', 1);
    setCarry();
    audio.fireFeed();
  } else if (torch.held && !torch.burning && ((nearFire && campfire.fuel > 0) || (nearHearth && cabin.fuel > 0))) {
    if (!torch.ignite()) return;
    audio.fireFeed();
  } else if (kind === 'log' && nearPile) {
    if (woodpile.count >= woodpile.capacity) return;
    saver.inventory.take('log', 1);
    woodpile.add(); saver.notePile(woodpile.count);
    setCarry(); audio.woodStack();
  } else if (target?.kind === 'stock' && kind === target.item) {
    setCarry(); audio.woodStack();
  } else if (target?.kind === 'workbench' && workbenchRecipe) {
    if (!applyRecipeAt(workbenchRecipe, saver.inventory, 'workbench')) return;
    if (kind && workbenchRecipe.take[kind]) setCarry();
    audio.woodStack(1.35);
  } else if (kind && buildTarget) {
    if (kind === 'timber' || kind === 'block') {
      if (!homestead.place(kind, buildTarget, {playerPosition: player.pos})) return;
      saver.inventory.take(kind, 1); setCarry(); audio.woodStack();
    } else {
      if (!buildRecipe || !applyRecipe(buildRecipe, saver.inventory, digger, buildTarget, buildAvoid)) return;
      setCarry();
    }
  } else if (kind) {
    const p = dropPoint();
    const yaw = Math.atan2(_dirTmp.x, _dirTmp.z) + Math.PI / 2;
    if (kind === 'log') groundLogs.drop(p.x, p.y, p.z, yaw);
    else yard.drop(kind, p, yaw);
    saver.inventory.take(kind, 1); setCarry(); audio.woodDrop();
  } else if (target?.kind === 'stock') {
    if (target.item === 'torch') torch.take();
    else setCarry(target.item);
    audio.woodTake();
  } else if (target?.kind === 'resource') {
    if (saver.inventory.add(target.item, 1) !== 1) return;
    yard.take(target.ref); setCarry(target.item); audio.woodTake();
  } else if (target?.kind === 'construction') {
    if (!homestead.canRemove(target.ref)) return;
    const item = target.ref.kind;
    if (saver.inventory.add(item, 1) !== 1) return;
    if (!homestead.remove(target.ref)) { saver.inventory.take(item, 1); return; }
    setCarry(item); audio.woodTake();
  } else if (target?.kind === 'log' || target?.kind === 'pile') {
    if (saver.inventory.add('log', 1) !== 1) return;
    if (target.kind === 'log') groundLogs.take(target.ref);
    else { woodpile.take(); saver.notePile(woodpile.count); }
    setCarry('log'); audio.woodTake();
  } else if (target?.kind === 'torch') {
    if (!torch.takePlaced(target.ref, saver.inventory, (p, take) => saver.notePlace('torch', p, take))) return;
  } else if (target && ['shovel', 'axe', 'pickaxe', 'hammer'].includes(target.kind)) {
    ({shovel, axe, pickaxe, hammer})[target.kind].take();
    shovelHintT = axeHintT = pickaxeHintT = hammerHintT = 9;
    if (target.kind === 'shovel') audio.shovelTake();
    else if (target.kind === 'axe') audio.axeTake(); else audio.pickaxeTake();
  } else if (torch.held) {
    if (!torch.plantAt(torchTarget || dropPoint(), saver.inventory,
      (p, take) => saver.notePlace('torch', p, take))) return;
  } else {
    const held = [shovel, axe, pickaxe, hammer].find(tool => tool.held && !tool.busy);
    if (!held) return;
    const p = dropPoint();
    held.plant(p.x, p.y, p.z, Math.atan2(_dirTmp.x, _dirTmp.z));
    audio.pickaxePlant();
  }
  yard.update(saver.inventory, player.carryKind, torch.held);
  shadowDirty = true;
  // Capture the completed transfer while the page is alive, including carry
  // and inventory. A pending footprint read must not delay this checkpoint.
  void saver.save({ sync: true });
}

// тач-управление (телефон/планшет): создаётся только на тач-устройствах —
// на десктопе ни кнопок, ни слушателей. Палец слева — идти, справа — смотреть.
function toggleTorch() {
  if (!player.locked || saver.blocked || stats.dead || player.carrying) return;
  if (torch.held) {
    if (!torch.plantAt(torchTarget || dropPoint(), saver.inventory,
      (p, take) => saver.notePlace('torch', p, take))) return;
    yard.update(saver.inventory, player.carryKind, torch.held);
    shadowDirty = true;
    void saver.save({ sync: true });
  } else if (handTarget?.kind === 'torch' ||
    (handTarget?.kind === 'stock' && handTarget.item === 'torch')) doHandAction();
}

addEventListener('keydown', (ev) => {
  if (ev.code !== 'KeyT' || ev.repeat || ev.defaultPrevented ||
    ev.target?.closest?.('button, a, input, textarea, select, [contenteditable]')) return;
  toggleTorch();
});
const touch = touchSupported() ? createTouch(input, look, toggleTorch) : null;

const saveNotice = document.getElementById('saveNotice');
const saveMessage = document.getElementById('saveMessage');
const saveRetry = document.getElementById('saveRetry');
const enterButton = document.getElementById('enter');
function showSaveStatus(status) {
  const ok = status === 'ok';
  document.body.classList.toggle('save-issue', !ok);
  saveNotice.hidden = ok;
  enterButton.disabled = !ok;
  resetBtn.disabled = !ok;
  if (ok) return;
  saveMessage.textContent = status === 'conflict'
    ? 'Мир сохранён в другой вкладке. Загрузите его, чтобы продолжить.'
    : status === 'read-error'
      ? 'Не удалось прочитать сохранение. Оно осталось на месте. Попробуйте открыть мир снова.'
      : 'Не удалось сохранить мир. Не закрывайте эту вкладку и попробуйте ещё раз.';
  saveRetry.textContent = status === 'conflict' ? 'загрузить сохранение'
    : status === 'read-error' ? 'открыть мир снова' : 'повторить сохранение';
  input.halt();
  input.free = false;
  setToolHeld(1, false);
  setToolHeld(2, false);
  if (touch) {
    touch.resetInput();
    touch.active = false;
    touch.ui.classList.remove('on');
  }
  if (document.pointerLockElement) document.exitPointerLock();
  shell.open();
  requestAnimationFrame(() => saveRetry.focus({ preventScroll: true }));
}
saver.onStatus = showSaveStatus;
showSaveStatus(saver.status);
saveRetry.addEventListener('click', async () => {
  if (saver.blocked) { location.reload(); return; }
  saveRetry.disabled = true;
  try {
    if (await saver.save()) enterButton.focus({ preventScroll: true });
  } finally { saveRetry.disabled = false; }
});

// Прогрев НАСТОЯЩИМ кадром: программы шейдеров, VBO и заливка текстур в GPU.
// renderer.compile() тут не годится: он собирает программы под канвас (srgb),
// а мир рисуется композером в рендер-таргет (srgb-linear) — это другой ключ
// программы (outputColorSpace в WebGLPrograms), и при первом повороте камеры
// всё за пределами стартового ракурса компилировалось заново + заливались
// VBO и текстуры невидимых объектов — секундный фриз (Windows/ANGLE).
// Поэтому: гасим frustum culling и рисуем кадр композером. Culling
// возвращаем сразу же.
//
// Прогрев идёт ПОРЦИЯМИ ПО КАДРАМ, и это не украшение, а условие живого меню.
//
// Замер (01.09.2026, dev, эта машина): экран входа открывался на 2.26 с, и
// сразу за ним главный поток стоял 2.2 с одной задачей. Полторы секунды из них
// — прогрев одним кадром: изба, лес и мебель компилировали свои программы и
// заливали VBO разом. Всё это время кнопка «войти в ночь» была нарисована, но
// не могла отработать нажатие: обработчик просто не получал очереди. Снаружи
// это и читалось как «меню ждёт мира».
//
// Здесь тот же кадр разбит на порции: рисуем столько объектов, сколько
// укладывается в бюджет, и отдаём кадр браузеру. Размер порции подбирается
// сам — по тому, сколько заняла предыдущая. Прогрев от этого дольше по
// календарю, но он идёт ЗА меню, а не вместо него.
//
// Зовётся дважды: по миру, собранному кодом (сразу за открытием меню), и по
// приехавшей отделке. Второй заход не переделывает первый — прогретое помечено
// в `userData.warmed`, — и не идёт с ним внахлёст: очередь одна.
const WARM_BUDGET_MS = 12;

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function nextTask() {
  return new Promise((r) => setTimeout(r, 0));
}

let warmQueue = Promise.resolve();

/** Поставить прогрев в очередь. Два прогрева разом рисовали бы кадр дважды. */
function warmSpread() {
  warmQueue = warmQueue.then(() => warmSceneSpread());
  return warmQueue;
}

async function warmSceneSpread() {
  mark('прогрев начат');
  const pend = [];
  const deferredRoots = new Set();
  const deferredRoot = (object) => {
    for (let node = object; node && node !== scene; node = node.parent) {
      if (node.userData.bootDeferredRoot) return node;
    }
    return null;
  };
  scene.traverse((o) => {
    // Только то, что рисуется: группы и пустышки прогревать нечем, а порции
    // из них состояли бы наполовину.
    const drawable = o.isMesh || o.isPoints || o.isLine;
    const root = deferredRoot(o);
    if (root) deferredRoots.add(root);
    if (drawable && o.frustumCulled && !o.userData.warmed && (o.visible || root)) {
      pend.push(o);
    }
  });
  if (pend.length === 0) {
    mark('прогрев кончен (0 объектов)');
    return;
  }
  // Приехавшее ПРЯЧЕТСЯ и открывается порциями — иначе порции не значат ничего
  // (замер трассой, 03.09.2026). Погашенный frustum culling решает только одну
  // задачу: втянуть в кадр то, чего в нём нет. А только что добавленная волна
  // в кадре И ТАК стоит — изба в двадцати метрах, лес вокруг поляны, — и
  // первый же `composer.render()` компилировал её ЦЕЛИКОМ: 743 мс одной
  // задачей главного потока сразу за «изба собрана», сколько бы объектов ни
  // было в порции. Поэтому волна въезжает невидимой, а порция сперва открывает
  // свои объекты и лишь потом рисует: в кадре ровно то, что мы готовы оплатить.
  const hidden = new Set();
  for (const o of pend) {
    if (o.userData.visibilityManaged) continue;
    if (!o.visible && !deferredRoot(o)) continue;
    o.visible = false;
    hidden.add(o);
  }
  // Сначала дожидаемся программ без блокировки потока. После этого порционные
  // кадры платят только за буферы, текстуры и собственно рисование.
  await compileObjectsAsync(pend, 1700);
  await reflectSceneProgramsAsync();
  await reflectRendererProgramsAsync();
  await primeSceneTexturesAsync();
  // Модель могла доехать внутрь скрытой группы, пока работал компилятор.
  // Перед открытием корня такие дочерние меши тоже прячем в порции.
  for (const root of deferredRoots) {
    root.traverse((object) => {
      const drawable = object.isMesh || object.isPoints || object.isLine;
      if (object.userData.visibilityManaged) return;
      if (!drawable || hidden.has(object) || !object.visible) return;
      object.visible = false;
      hidden.add(object);
      pend.push(object);
    });
    root.visible = true;
    delete root.userData.bootDeferredRoot;
  }
  let size = 4;
  try {
    for (let i = 0; i < pend.length; ) {
      const part = pend.slice(i, i + size);
      i += part.length;
      for (const o of part) {
        if (hidden.has(o)) o.visible = true;
        o.frustumCulled = false;
        o.userData.warmed = true;
      }
      const t0 = performance.now();
      digger.primeStart();
      // Карта теней перерисовывается на каждой порции: depth-варианты программ
      // компилируются только в теневом проходе, и без этого фриз просто уехал
      // бы на первую тень в кадре.
      renderer.shadowMap.needsUpdate = true;
      composer.render();
      digger.primeEnd();
      // Дождаться, пока нарисованное действительно нарисуется. Без этого замер
      // врёт, и врёт в худшую сторону: команды GL уходят в очередь и возвращают
      // управление сразу, компиляция программ идёт лениво, `spent` выходит в
      // единицы миллисекунд - и порция растёт до потолка. `finish` делает цену
      // порции честной, и подбор размера начинает работать.
      renderer.getContext().finish();
      const spent = performance.now() - t0;
      for (const o of part) o.frustumCulled = true;
      // Порция растёт, пока кадр укладывается в бюджет, и сжимается, если нет.
      size = spent > WARM_BUDGET_MS ? Math.max(1, size >> 1) : Math.min(32, size + 2);
      await nextFrame();
    }
  } finally {
    // Что бы ни случилось посреди прогрева, мир не должен остаться дырявым.
    for (const o of hidden) o.visible = true;
  }
  await reflectRendererProgramsAsync();
  view.render(renderer); // сцена рук — своим кадром, она рисуется отдельно
  mark(`прогрев кончен (${pend.length} объектов)`);
}

// Заставка уходит по ПЕРВОМУ КАДРУ, а не по загруженным ассетам, и это главное
// решение всей загрузки мира.
//
// Раньше здесь стояло `DefaultLoadingManager.onLoad = warmUp`: экран держался,
// пока не приедет всё до последнего байта — пять с половиной мегабайт, тридцать
// секунд на 1.5 Мбит/с, и десятисекундный предохранитель на случай, если сеть
// оборвётся совсем. Ждать приходилось и того, что со старта не видно вовсе:
// книг на столе внутри избы, чугунка у камина, дальнего края леса.
//
// Теперь мир, собранный кодом, показывается сразу, а изба и лес доезжают
// волной отделки (ниже), пока игрок читает титул на экране входа.
//
// Само появление ведёт `awaken.js`: мир проступает из темноты сквозь пелену, а
// по входу она отходит и опущенный взгляд поднимается. Модуль владеет на это
// время туманом, светом, звуком и камерой — см. его шапку.
const EXPOSURE = renderer.toneMappingExposure;
// Во сколько раз пелена входа плотнее той, что насчитала метель. Объявлена ДО
// createAwakening: тот сразу ставит первую ступень, то есть пишет сюда.
let fogVeil = 1;
const awakening = createAwakening({
  // Плотность живёт множителем, а не присваиванием: её КАЖДЫЙ КАДР
  // пересчитывает метель (см. `scene.fog.density` в тике), и прямая запись
  // держалась бы ровно до следующего кадра.
  setFog: (times) => {
    fogVeil = times;
  },
  setLight: (mul) => {
    renderer.toneMappingExposure = EXPOSURE * mul;
  },
  setSound: (level) => {
    audio.setWake(level);
  },
  look,
  yaw: look.yaw,
});

// Туман экрана входа снимается ОТДЕЛЬНЫМ сигналом, не готовностью мира
// (`__FTE_BOOT__.unveil`, см. его шапку). Здесь к нему привязано начало
// появления: пелена мира отходит ровно тогда, когда расходится туман меню, а
// не двумя секундами раньше, в пустоту за сплошной подложкой.
//
// Идемпотентно: сигналов, ведущих сюда, три - последняя волна отделки, вход
// игрока и предохранитель по времени. Кто пришёл первым, тот и открывает мир.
let worldUnveiled = false;
function unveilWorld() {
  if (worldUnveiled) return;
  worldUnveiled = true;
  if (!debug) awakening.reveal(); // мир начинает проступать из темноты
  window.__FTE_BOOT__?.unveil();
}
// Предохранитель: волна может не упасть, а просто зависнуть (сеть отвечает по
// байту в минуту). `allSettled` такого не ловит, и туман остался бы навсегда.
setTimeout(unveilWorld, 15000);

// Ворота отделки, которую можно считать только ПОСЛЕ первого кадра. Изба
// ждёт компилятора (`coreSceneCompiled`) - ей ещё ехать по сети, и ожидание
// прячется за загрузкой. У леса сети больше нет вовсе: сосны считаются кодом
// и без ворот начали бы считаться прямо в критическом пути входа.
let openWorldGate;
const worldReady = new Promise((resolve) => { openWorldGate = resolve; });
worldReady.then(async () => {
  const { Wildlife } = await import('./wildlife.js');
  wildlife = new Wildlife(scene, {
    seed: WORLD_SEED,
    surfaceAt: (x, z) => {
      const h = terrain.getHeight(x, z);
      return digger.surfaceBelow(x, z, h + 1, h - 2);
    },
    canStand: (x, z, y) => !cabin.isInside(x, z)
      && homestead.floorHeightAt(x, z) === null
      && !colliders.some(o => o.r && Math.hypot(x - o.x, z - o.z) < o.r + 0.5)
      && digger.densityAt(x, y + 0.15, z) < 0,
  });
  await prepareMatsets('rubble', 'beam');
  homestead.setMaterials({
    timber: material(matset('beam'), {normalScale: 0.2, roughness: 0.95, color: 0x998373}),
    block: material(matset('rubble'), {normalScale: 0.35, roughness: 0.95, color: 0x9b9b98}),
  });
}).catch(error => console.warn('Отделка мастерской:', error));

let warmed = false;
function warmUp() {
  if (warmed) return;
  warmed = true;
  requestAnimationFrame(async () => {
    await Promise.all([coreSceneCompiled, postProgramsCompiled, coreTexturesPrimed]);
    // Последний пакет uniform-ов и загрузка текстур приходят продолжениями
    // promise. Отделяем от них настоящий кадр новой задачей браузера.
    await nextFrame();
    // Один обычный кадр — чтобы за экраном входа было что показать. Прогрев
    // всего остального идёт ниже, ЗА уже открытым меню: раньше он стоял здесь
    // и задерживал экран на полсекунды, а следом ещё и подмораживал его.
    //
    // `__FTE_BOOT__.ready()` зовётся ровно один раз и ровно отсюда (через
    // `shell.ready()`): им мир и забирает кнопки экрана себе.
    digger.primeStart();
    composer.render();
    digger.primeEnd();
    await nextTask();
    view.render(renderer);
    for (const object of coreDrawables) object.userData.warmed = true;
    footprints.stampCircle(FIRE.x, FIRE.z, 1.9, 1);
    mark('мир собран');
    if (debug) {
      // ?debug идёт мимо экрана входа, а с ним — мимо появления мира: без
      // этой строки мир остался бы тёмным и неуправляемым.
      window.__FTE_BOOT__?.ready({ enter: enterWorld, reset: armReset });
      unveilWorld(); // ?debug идёт мимо меню - и мимо ожидания отделки
      shell.close();
      awakening.skip();
      if (saver.status !== 'ok') showSaveStatus(saver.status);
      // ?debug идёт мимо экрана входа: звук заводится первой же клавишей.
      const initAudio = () => {
        audio.init();
        audio.resume();
        removeEventListener('keydown', initAudio);
      };
      addEventListener('keydown', initAudio);
    } else {
      // Экран входа уже открыт — мир лишь забирает его себе. Нажатия,
      // сделанного до этой минуты, не бывает: кнопок на экране ещё нет.
      //
      // Туман при этом НЕ снимается: мир встал на ноги, но поляна за меню ещё
      // пуста - ни избы, ни леса, ни мебели. Его снимет `unveilWorld`, когда
      // приедет последняя волна; вместе с ним проступят и кнопки.
      shell.ready();
      if (saver.status !== 'ok') showSaveStatus(saver.status);
    }
    // Сигнал готовности не склеивается с запуском фоновой отделки в одну
    // длинную задачу. Меню получает отдельную очередь для первого ввода.
    await nextTask();
    startLoop();
    openWorldGate(); // первый кадр показан - лес может считаться
    keepOffline(); // следующий приход в мир — без сети (offline.js)
    digger.bakeMaterialSets(); // наборы среза (камень, грунт, руда) уже при живом мире
    // Прогрев мира, собранного кодом: порциями по кадрам, при живом меню.
    warmSpread();
  });
}
warmUp();

// ---------- волны отделки ----------
// Порядок здесь — это порядок, в котором мир одевается на глазах, и выбран он
// по одному признаку: видно ли это со старта.
//
//   1. Изба и лес — весь силуэт мира: тёплые окна в двадцати метрах и стена
//      сосен вокруг поляны. Запрашиваются вместе, но изба первой: она ближе,
//      вдвое легче леса, и без неё поляна выглядит просто пустой.
//   2. Мебель внутри избы (чугунок, книги) — её не видно, пока не войдёшь.
//      Уходит последней, отдельной волной внутри createCabin.
//
// Сорванная волна мир не роняет: без леса поляна пуста, без избы негде
// греться, но ходить, копать и жечь костёр можно и так. Поэтому allSettled,
// а не all — упавшая изба не должна уносить с собой приехавший лес.
let dressed = null; // последняя волна: мебель внутри избы
(async () => {
  // Волна и разбирается порциями: приняв избу и лес, мир ещё раскладывает их
  // по реестрам, отбраковывает налезшее и поднимает сейв. Стыки те же, что
  // внутри самих сборщиков (`spread.js`).
  const breathe = createSpread();
  const [cabinRes, treesRes] = await Promise.allSettled([
    createCabin(terrain, CABIN, coreSceneCompiled).then((v) => (mark('изба собрана'), v)),
    createTrees(terrain, 200, 45, [{ x: CABIN.x, z: CABIN.z, r: 7.5 }], caves, worldReady)
      .then((v) => (mark('лес собран'), v)),
  ]);

  if (cabinRes.status === 'fulfilled') {
    cabin = cabinRes.value;
    saver.attachHearth(cabin);
    colliders.push(...cabin.obstacles);
    snow.setCabinMask(cabin.snowMask); // под крышей снег не идёт
    await breathe();
    for (const light of cabinLightSlots) scene.remove(light);
    // та же причина, что у леса: волна не должна попасть в чужой кадр целиком
    cabin.group.visible = false;
    cabin.group.userData.bootDeferredRoot = true;
    scene.add(cabin.group);
    // мебель внутри дома приезжает своей волной; её коллайдеры — следом
    dressed = cabin.dressed.then((late) => {
      mark('мебель на месте');
      if (late.length) colliders.push(...late);
    });
  } else {
    console.warn('изба не приехала:', cabinRes.reason);
  }

  if (treesRes.status === 'fulfilled') {
    trees = treesRes.value;
    // Круг avoid в createTrees держит от домика только СТВОЛЫ, и то с натяжкой:
    // сруб - повёрнутый прямоугольник 8.1 x 9.6 м, а крона взрослой сосны сама
    // по себе до 4 м в радиусе. Поэтому габарит домика домик и меряет сам, а лес
    // убирает по нему то, что залезло ветками внутрь. Отбраковка идёт ПОСЛЕ
    // раскладки и не двигает ни одну другую сосну (см. cull в trees.js).
    // Без избы отбраковывать нечем - тогда лес встаёт как разложен.
    trees.cull([...(cabin.footprint ? [{ ...cabin.footprint, margin: 0.5 }] : []),
      ...(yard.footprint ? [{ ...yard.footprint, margin: 0.4 }] : [])]);
    await breathe();
    // Порядок трёх следующих строк важен и держится на одном: лес попадает в
    // кадр последним. Сперва отбраковка снимает коллайдеры с убранных сосен,
    // потом рубка принимает лес, потом сейв кладёт на место сваленное в
    // прошлую ночь - и только после этого лес добавляется в сцену. Иначе
    // вернувшийся игрок увидел бы, как срубленная им сосна падает заново.
    lumber.setForest(trees.pines);
    saver.forestReady();
    colliders.push(...trees.obstacles);
    await breathe();
    // Лес въезжает НЕВИДИМЫМ, как предметы переднего плана на старте: пока
    // сосны считались паком, они доезжали позже прогрева и попадали в свою
    // порцию. Считаясь кодом, лес готов уже к 2.1 с - ровно посреди первого
    // прогрева, - и первый же его кадр компилировал ВЕСЬ лес разом (1616 мс
    // одной задачей, замер китом входа 04.09.2026). Пометка `bootDeferredRoot`
    // отдаёт группу порционному прогреву: он сам откроет её и оплатит
    // программы порциями (см. warmSceneSpread).
    trees.group.visible = false;
    trees.group.userData.bootDeferredRoot = true;
    scene.add(trees.group);
  } else {
    console.warn('лес не приехал:', treesRes.reason);
  }

  // Отделка на месте: опора под ногами настоящая, придерживать больше нечего.
  player.holdY = null;
  shadowDirty = true; // приехавшее отбрасывает тени
  // Программы и текстуры отделки — порциями по кадрам, а не одним кадром на
  // полторы секунды: пока идёт прогрев, меню обязано отвечать на нажатие.
  await warmSpread();

  // Последняя волна - мебель внутри избы. Ждём и её: мир считается собранным,
  // только когда доехало всё, что вообще доедет. `allSettled`, а не `then`:
  // упавшая мебель не должна оставить человека за туманом навсегда.
  await Promise.allSettled([dressed]);
  await warmSpread(); // прогреть то, что принесла мебель

  // Мир одет целиком - туман расходится и открывает его за меню.
  mark('мир одет');
  unveilWorld();
})();

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
let loopStarted = false;
const PAUSE_FRAME_MS = 1000 / 30;
let nextPauseFrameAt = 0;

function startLoop() {
  if (loopStarted) return;
  loopStarted = true;
  clock.start();
  requestAnimationFrame(tick);
}
let fadeAcc = 0;
let meltAcc = 0;
let blizzard = 0; // 0..1 — сглаженная сила метели
let nearDoor = false; // рядом с дверью — работает F
let nearFire = false; // рядом с костром — F подбрасывает полено
let nearPile = false; // рядом с поленницей — F складывает принесённое полено
let handTarget = null; // ближайший к прицелу предмет, который возьмёт F
let buildTarget = null; // поверхность, на которую пустая рука положит материал
let buildRecipe = null; // первый доступный рецепт: камень, грунт, снег
let workbenchRecipe = null; // первый доступный рецепт верстака
let torchTarget = null; // точка поверхности для воткнутого факела
let nearHearth = false;
let shovelHintT = 0; // сек показа подсказки после взятия лопаты
let axeHintT = 0; // сек показа подсказки после взятия топора
let pickaxeHintT = 0; // сек показа подсказки после взятия кирки
let hammerHintT = 0; // сек показа подсказки после взятия молота
let carryHintT = 0; // сек показа подсказки «бросить полено»
let shadowAcc = 0; // таймер перерисовки карты теней
const _sRight = new THREE.Vector3(); // базис плоскости окна теней (⊥ лучу луны)
const _sUp = new THREE.Vector3();
let indoorK = 0; // 0..1 — сглаженное «мы в домике» (глушит ветер, греет)
let caveK = 0; // 0..1 — сглаженное «мы в вырытой пещере» (укрытие)
let caveTarget = 0;
let shelterAcc = 0;
const promptEl = document.getElementById('prompt');
let promptShown = false; // что уже стоит в DOM: класс видимости и сам текст
let promptLast = null;
const _toFire = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _dirTmp = new THREE.Vector3();
const _sprayDir = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _aim2 = new THREE.Vector3();

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
  if (kind === 'dig' && digger.lastStroke?.strength === 0) return true;
  camera.getWorldDirection(_dirTmp);
  // при копке крошка летит на копающего и вверх; при укладке — вперёд от штыка
  _sprayDir.copy(_dirTmp).multiplyScalar(kind === 'dig' ? -0.7 : 0.5);
  _sprayDir.y = kind === 'dig' ? 1.3 : 0.7;
  shovel.spray(p, _sprayDir);
  return true;
}

// Врезание топора: lumber решает, во что пришёлся удар (стоящая сосна или
// лежащий ствол) и что случилось (зарубка, валка, полено). Промах по воздуху
// не отдаёт в камеру.
function onAxeImpact(kind) {
  const hit = lumber.chop(camera, player.pos, kind === 'timber');
  if (!hit) {
    audio.shovelWhiff(); // свист по воздуху общий у всех инструментов
    return false;
  }
  axe.spray(hit.point, hit.out);
  audio.axeChop();
  if (hit.split) audio.woodSplit(); // от ствола откололось полено
  shadowDirty = true;
  return true;
}

// Врезание кирки: маленькая сферическая правка и каменная крошка.
function onPickaxeImpact() {
  const p = digger.pickaxeEdit(camera);
  if (!p) {
    audio.shovelWhiff();
    return false;
  }
  audio.pickaxeHit(digger.lastStroke?.material ?? 2);
  camera.getWorldDirection(_dirTmp);
  _sprayDir.copy(_dirTmp).multiplyScalar(-0.55);
  _sprayDir.y = 1.05;
  pickaxe.spray(p, _sprayDir);
  shadowDirty = true;
  return true;
}

// Молот без готового блока долбит камень вдвое слабее кирки.
function onHammerImpact() {
  const p = digger.hammerEdit(camera);
  if (!p || !digger.lastStroke?.strength) {
    audio.shovelWhiff();
    return false;
  }
  audio.pickaxeHit(digger.lastStroke.material);
  camera.getWorldDirection(_dirTmp);
  _sprayDir.copy(_dirTmp).multiplyScalar(-0.45);
  _sprayDir.y = 0.9;
  hammer.spray(p, _sprayDir);
  shadowDirty = true;
  return true;
}

// Пещера-укрытие: если над головой грунт, а вокруг стены — игрок в закрытом
// объёме. Сэмплы непрерывного SDF диггера (реже кадра — see shelterAcc).
// Выкопанная в метель нора глушит ветер УШАМИ — так игрок узнаёт, что построил
// укрытие, без единой надписи.
function sampleCave() {
  const p = camera.position;
  return caveShelter((x, y, z) => digger.densityAt(x, y, z), (x, z) => terrain.getHeight(x, z), p);
}

function tick(frameAt) {
  requestAnimationFrame(tick);
  // Фон паузы живёт в 30 кадрах/с: плавный снег при меньшем числе рендеров.
  // Пробуждение и игра идут с частотой экрана. Интервал паузы меньше
  // потолка dt (0.05 с), поэтому атмосфера не замедляется вдвое, как при 10 FPS.
  //
  // И отдельно: пока туман экрана входа сплошной, мира за ним не видно вовсе -
  // рисовать его значит греть видеокарту в пустоту и отбирать кадры у меню.
  // Прогревочные кадры (`warmSpread`, `primeStart`/`primeEnd`) идут мимо этой
  // проверки: они рисуют сами, не через цикл, и нужны для компиляции шейдеров.
  // Раньше здесь стояло `!unveiled && !awakening.holds()`, и это не работало:
  // `holds()` истинно от начала появления до самого конца входа, то есть всё
  // время под туманом. Мир честно рисовался в никуда и отбирал кадры у меню.
  // Теперь условие одно: нет тумана - есть кадры. Вход туман снимает сам
  // (`unveilWorld`), так что войти в нерисуемый мир нельзя.
  if (document.hidden || !document.body.classList.contains('unveiled')) {
    nextPauseFrameAt = 0;
    return;
  }
  if (document.body.classList.contains('paused') && !awakening.holds()) {
    // Держим сетку времени, а не отсчитываем интервал от опоздавшего кадра.
    // Допуск 0.5 мс учитывает округление rAF; после фриза не догоняем кадры.
    if (frameAt + 0.5 < nextPauseFrameAt) return;
    nextPauseFrameAt = frameAt - nextPauseFrameAt >= PAUSE_FRAME_MS
      ? frameAt + PAUSE_FRAME_MS
      : nextPauseFrameAt + PAUSE_FRAME_MS;
  } else {
    nextPauseFrameAt = 0;
  }
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const dbg = debug;
  if (dbg) _fm[0] = performance.now();

  sky.update(t); // луна ползёт по полярному кругу — ДО блока теней: снап в свежем базисе

  // Тени: окно карты ведём за игроком, перерисовка — по таймеру или событию.
  // Блок стоит ДО физики и лопаты. Публикация готового раскопа ниже отдельно
  // взводит needsUpdate в этом же кадре, чтобы тень не отставала от геометрии.
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
  scene.fog.density = (FOG_CALM + blizzard * (FOG_STORM - FOG_CALM)) * fogVeil;
  for (const m of ridges.mats) m.opacity = 1 - blizzard * 0.8;

  // Пока идёт пробуждение, игрок не управляет ничем: камерой ведёт awaken.js.
  // Мир вокруг при этом живёт — снег летит, огонь дышит, пелена отходит.
  awakening.update(dt);
  if (!awakening.holds()) {
    // взгляд — ДО физики: направление движения должно идти по свежей камере
    look.update(dt, player);
    player.update(dt);
    const ceiling = homestead.ceilingHeightAt(player.pos.x, player.pos.z, player.pos.y, player.radius);
    if (ceiling !== null && player.pos.y + player.height > ceiling - 0.02) {
      player.pos.y = ceiling - player.height - 0.02;
      player.vy = Math.min(0, player.vy);
      player.syncCamera();
    }
    footprints.updateView(player.pos.x, player.pos.z); // окно детальной карты следов
  }
  if (dbg) _fm[2] = performance.now(); // ловец: конец физики

  // Инструменты повторяют замах, пока кнопка удержана.
  if (shovel.held && (digHeld || buildHeld)) shovel.trySwing(digHeld ? 'dig' : 'build');
  shovel.update(dt, onShovelImpact);
  if (axe.held && (chopHeld || timberHeld)) axe.trySwing(timberHeld ? 'timber' : 'chop');
  axe.update(dt, onAxeImpact);
  if (pickaxe.held && mineHeld) pickaxe.trySwing('mine');
  pickaxe.update(dt, onPickaxeImpact);
  if (hammer.held && mineHeld) {
    hammer.trySwing('mine');
  }
  hammer.update(dt, onHammerImpact);
  for (const tool of [shovel, axe, pickaxe, hammer]) fitToolToAspect(tool, camera.aspect);
  torch.update(dt, t, camera, 2, { blizzard, shelter: Math.max(indoorK, caveK,
    homestead.shelterAt(camera.position)), spend: player.locked,
    shelterAt: p => cabin.isInside(p.x, p.z) ? 1 : Math.max(homestead.shelterAt(p),
      caveShelter((x, y, z) => digger.densityAt(x, y, z), (x, z) => terrain.getHeight(x, z), p)) });
  lumber.update(dt, player.pos); // дрожь крон и валка — после ударов этого кадра
  // Падающее дерево тащит тень за собой; дрожь кроны — нет. Разница в цене
  // велика: дрожь длится около секунды после КАЖДОГО удара топором, и на этом
  // флаге полная карта теней перерисовывалась каждый кадр всю рубку.
  if (lumber.felling) shadowDirty = true;
  yard.update(saver.inventory, player.carryKind, torch.held);
  view.update(dt, player); // sway/bob/дыхание/просадка — общие для всего, что в руках
  if (dbg) _fm[3] = performance.now(); // ловец: конец лопаты/рук

  // пещера-укрытие: сэмплы SDF дороже кадра — обновляем цель ~5 раз/с
  shelterAcc += dt;
  if (shelterAcc > 0.2) {
    shelterAcc = 0;
    caveTarget = sampleCave();
  }
  caveK += (caveTarget - caveK) * Math.min(1, dt * 2.5);

  // потоковая загрузка воксельных чанков: колонки вокруг игрока разбираются,
  // очередь уезжает в воркеры, готовое ставится в сцену (не больше двух за кадр)
  digger.update(player.pos);

  snowPatch.update(camera.position);
  const builtShelter = homestead.shelterAt(camera.position);
  snow.update(dt, t, camera.position, audio.windLevel, blizzard, Math.max(caveK, builtShelter));
  aurora.update(t, blizzard);
  breath.update(dt, player.exertion, audio.windLevel);
  campfire.update(dt, t, audio.windLevel, player.locked);
  cabin.update(t, dt, player.locked);
  critters.update(dt);
  if (dbg) _fm[4] = performance.now(); // ловец: конец мировых систем

  // домик/пещера: глушение ветра внутри, тепло от печки
  camera.getWorldDirection(_dirTmp);
  nearDoor = aimedAt(camera.position, _dirTmp, cabin.doorCenter)
    && visibility(camera, cabin.doorCenter, [cabin.group, homestead.group]);
  const inside = cabin.isInside(camera.position.x, camera.position.z);
  indoorK += ((inside ? 1 : 0) - indoorK) * Math.min(1, dt * 2.5);
  const shelter = Math.max(indoorK, caveK, builtShelter);
  wildlife?.update(dt, t, player.pos, { blizzard, shelter, spend: player.locked,
    direction: _dirTmp, reducedMotion });
  // Второе число — чем именно укрыт: дом отвечает деревянной комнатой, нора не
  // отвечает вовсе. Пока укрытия нет, доля не имеет значения.
  audio.setIndoor(shelter, shelter > 0 ? caveK / Math.max(shelter, 1e-4) : 0);
  const stoveDist = camera.position.distanceTo(cabin.stovePos);
  const stoveHeat = THREE.MathUtils.clamp(1 - (stoveDist - 0.9) / 3.4, 0, 1);
  const cabinHeat = indoorK * Math.max(0.3, stoveHeat * 0.95) * cabin.heatK;

  // тепло от костра (угли греют еле-еле — heatK) + позиционный звук
  _toFire.copy(campfire.position).sub(camera.position);
  const fireDist = Math.hypot(_toFire.x, _toFire.z);
  const fireHeat = THREE.MathUtils.clamp(1 - (fireDist - 1.2) / 3.5, 0, 1) * campfire.heatK;
  // в пещере не греет, но и не выдувает: небольшой пассивный бонус
  const heat = Math.max(fireHeat, cabinHeat, caveK * 0.22, torch.heat);
  _camRight.set(1, 0, 0).applyQuaternion(camera.quaternion);
  const pan = fireDist > 0.3 ? (_toFire.x * _camRight.x + _toFire.z * _camRight.z) / fireDist : 0;
  audio.updateCampfire(fireDist, pan, campfire.burnU.value);

  // The same aim chooses the action and its caption. Materials leave a
  // visible stock one at a time; no remote inventory placement.
  camera.getWorldDirection(_dirTmp);
  const firePoint = campfire.position.clone(); firePoint.y += 0.45;
  nearFire = aimedAt(camera.position, _dirTmp, firePoint, 2.8, 0.8)
    && visibility(camera, firePoint, [cabin.group, homestead.group]);
  nearHearth = aimedAt(camera.position, _dirTmp, cabin.stovePos, 2.6, 0.78)
    && visibility(camera, cabin.stovePos, [cabin.group, homestead.group]);
  woodpile.topWorld(_aim2);
  nearPile = aimedAt(camera.position, _dirTmp, _aim2, 2.7, 0.8)
    && visibility(camera, _aim2, [cabin.group, homestead.group]);
  handTarget = buildTarget = buildRecipe = workbenchRecipe = torchTarget = null;
  const emptyTools = ![shovel, axe, pickaxe, hammer, torch].some(tool => tool.held);
  const kind = player.carryKind;
  const surface = digger.aimSurface(camera, 3.2);
  if (emptyTools) {
    let bestDot = 0.84;
    const consider = (candidate, p) => {
      _aim.copy(p).sub(camera.position);
      const dist = _aim.length();
      if (dist > 2.8 || dist < 0.02) return;
      // Terrain between the player and an item prevents reaching through it.
      if (surface && camera.position.distanceTo(surface.point) + 0.4 < dist) return;
      if (!visibility(camera, p, [cabin.group, homestead.group])) return;
      const dot = _aim.multiplyScalar(1 / dist).dot(_dirTmp);
      if (dot > bestDot) { bestDot = dot; handTarget = candidate; }
    };
    if (!kind) {
      if (woodpile.count) consider({kind:'pile'}, _aim2);
      for (const [name, tool, h] of [['shovel', shovel, .5], ['axe', axe, .35],
        ['pickaxe', pickaxe, .4], ['hammer', hammer, .25]])
        consider({kind:name}, new THREE.Vector3(tool.pos.x, tool.pos.y + h, tool.pos.z));
      for (const log of groundLogs.list) consider({kind:'log', ref:log},
        new THREE.Vector3(log.x, log.y + .1, log.z));
      for (const entry of torch.placed) consider({kind:'torch', ref:entry},
        entry.position.clone().add(new THREE.Vector3(0, .55, 0)));
      const part = homestead.pickTarget(camera, 2.8);
      if (part) consider(part, part.point || part.ref.mesh.position);
    }
    const stock = yard.target(camera, saver.inventory, kind);
    if (stock) consider(stock, stock.position);
    // Real work areas on the bench distinguish splitting from stonework.
    for (const zone of workbench.zones) {
      if (!kind || zone.recipe.take[kind]) consider({kind:'workbench', recipe:zone.recipe}, zone.position);
    }
    if (handTarget?.kind === 'workbench') workbenchRecipe = handTarget.recipe;
    if (kind === 'timber' || kind === 'block') buildTarget = homestead.target(surface, camera, kind, player.pos);
    else if (kind === 'soil' || kind === 'snow') {
      buildRecipe = RECIPES.find(r => r.verb === 'build' && r.take[kind]);
      if (surface && !buildAvoided(surface.point, buildAvoid, buildRecipe.give.radius)) buildTarget = surface.point;
    }
  }
  if (torch.held) torchTarget = torchPlacement(surface);
  woodpile.preview(kind === 'log' && nearPile && woodpile.count < woodpile.capacity ? 'add'
    : handTarget?.kind === 'pile' ? 'take' : null);
  if (shovel.held) shovelHintT -= dt;
  if (axe.held) axeHintT -= dt;
  if (pickaxe.held) pickaxeHintT -= dt;
  if (hammer.held) hammerHintT -= dt;
  const canDrawTorch = !kind && emptyTools && (handTarget?.kind === 'torch' ||
    (handTarget?.kind === 'stock' && handTarget.item === 'torch'));
  let promptText = null;
  if (nearDoor) promptText = cabin.doorOpen ? 'F — закрыть дверь' : 'F — открыть дверь';
  else if (kind === 'log' && (nearFire || nearHearth))
    promptText = (nearHearth ? cabin : campfire).fuel < 1 ? 'F — подбросить полено' : 'дров пока достаточно';
  else if (torch.held && !torch.burning && ((nearFire && campfire.fuel > 0) || (nearHearth && cabin.fuel > 0)))
    promptText = torch.needsFuel ? 'факел прогорел' : 'F — зажечь факел';
  else if (kind === 'log' && nearPile)
    promptText = woodpile.count < woodpile.capacity ? 'F — сложить полено' : 'поленница полна';
  else if (handTarget?.kind === 'stock') promptText = `F — ${kind ? 'сложить' : 'взять'} ${resourceName(handTarget.item)}`;
  else if (workbenchRecipe) {
    const ready = Object.entries(workbenchRecipe.take).every(([id,n]) => saver.inventory.count(id) >= n);
    promptText = ready ? `F — ${workbenchRecipe.name}` : workbenchRecipe.id === 'make-torch'
      ? 'сюда нужно смолистое полено' : workbenchRecipe.id === 'dress-ore'
        ? 'сложите рядом железистый камень' : 'сложите рядом камни';
  } else if (buildTarget) promptText = `F — ${kind === 'timber' ? (buildTarget.form === 'roof' ? 'уложить доску крыши' : 'уложить бревно')
    : kind === 'block' ? 'уложить блок' : buildRecipe.name}`;
  else if (kind) promptText = `F — положить ${resourceName(kind)}`;
  else if (handTarget) {
    promptText = handTarget.kind === 'resource' ? `F — поднять ${resourceName(handTarget.item)}`
      : handTarget.kind === 'construction' ? (homestead.canRemove(handTarget.ref) ? 'F — вынуть деталь' : 'на этой детали лежат другие')
        : {pile:'F — взять полено', log:'F — поднять полено', shovel:'F — взять лопату',
          axe:'F — взять топор', pickaxe:'F — взять кирку', hammer:'F — взять молот', torch:'F — взять факел'}[handTarget.kind];
  } else if (torch.held) promptText = 'F — поставить факел';
  else if (shovel.held && shovelHintT > 0) promptText = 'ЛКМ — копать · ПКМ — намыть · F — воткнуть';
  else if (axe.held && axeHintT > 0) promptText = 'ЛКМ — поленья · ПКМ — строительное бревно · F — воткнуть';
  else if ((pickaxe.held && pickaxeHintT > 0) || (hammer.held && hammerHintT > 0)) promptText = 'ЛКМ — долбить · F — положить';
  if (touch?.active) {
    touch.setButtons({torch:canDrawTorch || torch.held, torchHeld:torch.held,
      action:nearDoor || !!kind || !!handTarget || !emptyTools,
      tool:shovel.held ? 'shovel' : axe.held ? 'axe' : pickaxe.held ? 'pickaxe' : hammer.held ? 'hammer' : null});
    if (promptText) promptText = promptText.startsWith('ЛКМ')
      ? (axe.held ? 'кнопки справа — поленья и брёвна' : shovel.held ? 'кнопки справа — копать и намыть' : 'кнопка справа — долбить')
      : promptText.replace(/^F — /, '');
  }

  // DOM трогаем только на смене. Раньше подсказка писалась каждый кадр:
  // класс и текст переставлялись 60 раз в секунду, чтобы остаться теми же.
  const promptOn = !!promptText && player.locked;
  if (promptOn !== promptShown) {
    promptShown = promptOn;
    promptEl.classList.toggle('show', promptOn);
  }
  if (promptText && promptText !== promptLast) {
    promptLast = promptText;
    promptEl.textContent = promptText;
  }

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

  // Снег постепенно заметает следы; проталина у костра живёт, пока он горит.
  // На паузе память мира стоит: вернуться и не найти собственной тропы -
  // то же самое, что вернуться к погасшему костру (см. campfire.update).
  if (player.locked) {
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
  }

  // Отдача от удара лопатой. Кладём её на камеру ровно на время кадра и снимаем
  // сразу после: SmoothLook пересобирает кватернион каждый кадр и в прицел punch
  // не утечёт, но viewmodel меряет угловую скорость взгляда по камере — оставленный
  // punch читался бы как рывок мыши. Дёргается мир — не viewmodel: он привязан
  // к виду, своя отдача у него в кейфреймах замаха.
  // отдача инструментов, в руках всегда максимум один
  const pitch = shovel.punch.pitch + axe.punch.pitch + pickaxe.punch.pitch
    + hammer.punch.pitch;
  const roll = shovel.punch.roll + axe.punch.roll + pickaxe.punch.roll
    + hammer.punch.roll;
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
