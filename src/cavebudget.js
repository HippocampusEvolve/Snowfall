// Бюджет потоковой загрузки пещер и сборка геометрии колонки.
//
// Модуль чистый: без three, DOM и воркеров. Поэтому те же правила, по которым
// главный поток держит меши, можно проверить в Node на настоящих буферах
// marching cubes, не поднимая рендерер.

import { DEPTH_MIN } from './caves.js';
import { VN, VS, SW } from './mesher.worker.js';

export const CAVE_LOAD_RADIUS = 24;
export const SURFACE_LOAD_RADIUS = 40;
export const STREAM_HYSTERESIS = 8;

export const chunkLoadRadius = (wide) => (wide ? SURFACE_LOAD_RADIUS : CAVE_LOAD_RADIUS);
export const chunkKeepRadius = (wide) => chunkLoadRadius(wide) + STREAM_HYSTERESIS;

/**
 * Склеить вертикальные части одной колонки в одну индексированную геометрию.
 * Координаты частей уже мировые, поэтому преобразовывать вершины не нужно.
 */
export function mergeChunkParts(parts) {
  const live = parts.filter(Boolean);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];

  let vertices = 0;
  let indices = 0;
  for (const p of live) {
    vertices += p.position.length / 3;
    indices += p.index.length;
  }

  const position = new Float32Array(vertices * 3);
  const normal = new Float32Array(vertices * 3);
  const material = new Uint8Array(vertices);
  const index = new Uint32Array(indices);
  let pv = 0;
  let pi = 0;
  let base = 0;
  for (const p of live) {
    position.set(p.position, pv);
    normal.set(p.normal, pv);
    if (p.material) material.set(p.material, pv / 3);
    for (let i = 0; i < p.index.length; i++) index[pi + i] = p.index[i] + base;
    pv += p.position.length;
    pi += p.index.length;
    base += p.position.length / 3;
  }
  return { position, normal, material, index };
}

// Шапка неразрезанной колонки: выше этой глубины под поверхностью её воксельный
// меш считает грунт сплошным. Ровно столько же обещает и поле пещер (DEPTH_MIN):
// свод сети выше не поднимается, наружу выходит только ствол выхода. Поэтому
// шапка ничего не прячет - она снимает вторую снежную поверхность там, где
// поверхность рисует сам террейн, и разрешает мешить свод пещеры, попавший
// в тот же чанк, что и поверхность.
export const SURFACE_CAP = DEPTH_MIN;

// Шаг проверки: 1 м по горизонтали (VN/4 вокселей) и 0.5 м по вертикали.
const OPEN_STEP = VN / 4;
const OPEN_DY = 0.5;
// Полудиагональ ячейки этой сетки: sdf мерян в метрах, поэтому «все узлы
// дальше 0.75 м» - честное доказательство, что пустоты в шапке нет.
const OPEN_MARGIN = 0.75;

/**
 * Выходит ли пещера НА ПОВЕРХНОСТЬ колонки: есть ли настоящая пустота в
 * верхних SURFACE_CAP метрах грунта. Это единственный природный повод вырезать
 * террейн под воксельный меш.
 *
 * Прежнее правило спрашивало другое - «нет ли пещеры ближе двух метров от
 * приповерхностной полосы» - и отвечало «да» там, где пустоты нет вовсе:
 * колонка резалась, воксельный меш вставал на место снега и торчал над ним
 * поднятым квадратом 4 на 4 метра.
 *
 * @param {object} caves поле пещер (createCaves)
 * @param {Float32Array} h baseHeight в SW² узлах колонки (с кольцом)
 * @param {number} cx индексы колонки
 * @param {number} cz
 */
export function surfaceOpen(caves, h, cx, cz) {
  // Первый проход - редкий и дешёвый: если КАЖДЫЙ узел сетки 1 x 1 x 0.5 м
  // дальше 0.75 м от пустоты, её нет во всей шапке, и колонка чиста.
  let near = false;
  for (let i = 0; i <= VN && !near; i += OPEN_STEP) {
    const x = (cx * VN + i) * VS;
    for (let k = 0; k <= VN && !near; k += OPEN_STEP) {
      const z = (cz * VN + k) * VS;
      const base = h[(k + 1) * SW + (i + 1)];
      for (let d = 0; d <= SURFACE_CAP + OPEN_MARGIN + 1e-6; d += OPEN_DY) {
        if (caves.sdf(x, base - d, z, d) < OPEN_MARGIN) { near = true; break; }
      }
    }
  }
  if (!near) return false;

  // Второй проход - по УЗЛАМ ВОКСЕЛЕЙ, и уже по знаку. Запас первого прохода
  // честный, но грубый: у стенки шахты, у цилиндра целого грунта вокруг избы,
  // да и просто рядом с ходом он срабатывает там, где пустоты нет вовсе.
  // Марширующие кубы видят ровно эти узлы - что мимо них, того в меше и нет.
  for (let i = 0; i <= VN; i++) {
    const x = (cx * VN + i) * VS;
    for (let k = 0; k <= VN; k++) {
      const z = (cz * VN + k) * VS;
      const base = h[(k + 1) * SW + (i + 1)];
      for (let d = VS; d <= SURFACE_CAP + 1e-6; d += VS) {
        if (caves.sdf(x, base - d, z, d) < 0) return true;
      }
    }
  }
  return false;
}
