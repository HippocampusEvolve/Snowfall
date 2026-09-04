import { makeSet, toTextures } from 'world-core/materials';

// Сначала нужны материалы дров первого кадра, затем среза и избы. Воркер
// считает чистые байтовые карты по очереди, а главный поток только оборачивает
// готовые массивы в канвы и текстуры.
const NAMES = [
  'log', 'bark', 'logend', 'split',
  'rubble', 'rubbleWarm', 'iron',
  'brick', 'hearth', 'beam', 'ashlar', 'floor',
  'cloth', 'wool', 'braid', 'leather', 'paper',
];

const cache = new Map();
const waits = new Map();
const requested = new Set();
let failed = false;

for (const name of NAMES) {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  waits.set(name, { promise, resolve });
}

const workers = Array.from({ length: 4 }, () =>
  new Worker(new URL('./materials.worker.js', import.meta.url), { type: 'module' })
);
for (const worker of workers) {
  worker.onmessage = ({ data: { name, baked } }) => {
    cache.set(name, toTextures(baked, name));
    waits.get(name)?.resolve();
  };
  worker.onerror = () => {
    failed = true;
    for (const { resolve } of waits.values()) resolve();
  };
}

let firstOrder = true; // первый заказ - это карты первого кадра
let spare = 1; // следующий свободный воркер для мелких заказов

function request(names) {
  if (failed) return;
  const fresh = names.filter((name) => waits.has(name) && !requested.has(name));
  if (!fresh.length) return;
  for (const name of fresh) requested.add(name);
  // Три карты первого кадра идут последовательно и не отнимают ядра у
  // компилятора. Большую отделку избы делим между фоновыми потоками.
  if (fresh.length > 3) {
    const batches = workers.map(() => []);
    fresh.forEach((name, i) => batches[i % workers.length].push(name));
    batches.forEach((batch, i) => workers[i].postMessage(batch));
  } else if (firstOrder) {
    firstOrder = false;
    workers[0].postMessage(fresh);
  } else {
    // А вот КАЖДЫЙ СЛЕДУЮЩИЙ мелкий заказ на нулевой воркер ставить нельзя.
    // Щебень кострища и железо лопаты заказываются позже трёх карт первого
    // кадра, но раньше снега, и, встав на тот же воркер, они отодвигали снег
    // на две выпечки - готовность мира ждала предметов, которых ещё не видно.
    // Мелочь уходит на свободные воркеры по кругу, нулевой остаётся за первым
    // кадром и за тем, что за ним следом.
    workers[spare].postMessage(fresh);
    spare = 1 + (spare % (workers.length - 1));
  }
}

/** Дождаться наборов, не занимая их выпечкой главный поток. */
export async function prepareMatsets(...names) {
  request(names);
  await Promise.all(names.map((name) => waits.get(name)?.promise));
  if (failed) {
    for (const name of names) if (!cache.has(name)) cache.set(name, makeSet(name));
  }
}

/** Взять набор, который был заказан через prepareMatsets. */
export function matset(name) {
  if (!cache.has(name)) cache.set(name, makeSet(name));
  return cache.get(name);
}

export function matsets(...names) {
  return Object.fromEntries(names.map((name) => [name, matset(name)]));
}
