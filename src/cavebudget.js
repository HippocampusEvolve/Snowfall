// Бюджет потоковой загрузки пещер и сборка геометрии колонки.
//
// Модуль чистый: без three, DOM и воркеров. Поэтому те же правила, по которым
// главный поток держит меши, можно проверить в Node на настоящих буферах
// marching cubes, не поднимая рендерер.

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
  const index = new Uint32Array(indices);
  let pv = 0;
  let pi = 0;
  let base = 0;
  for (const p of live) {
    position.set(p.position, pv);
    normal.set(p.normal, pv);
    for (let i = 0; i < p.index.length; i++) index[pi + i] = p.index[i] + base;
    pv += p.position.length;
    pi += p.index.length;
    base += p.position.length / 3;
  }
  return { position, normal, index };
}
