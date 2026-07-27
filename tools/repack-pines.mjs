// Пак сосен приехал со Sketchfab уже сжатым Draco, но с щадящим квантованием:
// scene.bin весил 1.7 МБ — больше всей остальной геометрии игры вместе.
// Здесь он перепаковывается плотнее: 12 бит на позицию — это ~4 мм на дерево
// высотой 15 м, глазом такого не поймать.
//
// Домик через ту же обработку не гонится: на нём draco() из gltf-transform
// оставляет геометрию несжатой и scene.bin раздувается впятеро (293K -> 1.4M).
//
// Разовый инструмент, в зависимостях проекта не держим:
//   npm i -D @gltf-transform/core @gltf-transform/extensions \
//            @gltf-transform/functions draco3dgltf
//   node tools/repack-pines.mjs
// Прогон идемпотентен по смыслу, но не по качеству: повторное кодирование
// уже квантованной геометрии копит ошибку — берите файл из истории git.
import fs from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { draco, weld, dedup } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

const SRC = 'public/models/pines/scene.gltf';
const BIN = 'public/models/pines/scene.bin';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
});

const before = fs.statSync(BIN).size;
const doc = await io.read(SRC);

// weld/dedup до кодирования: сваренные вершины Draco жмёт заметно лучше,
// а dedup убирает примитивы-дубликаты между LOD-узлами.
await doc.transform(
  dedup(),
  weld(),
  draco({ quantizePosition: 12, quantizeNormal: 8, quantizeTexcoord: 10, quantizeGeneric: 10 })
);

// Имена LOD-узлов (Pine_*_LOD0..2) и материалов (Bark_Mat/Clusters_Mat) —
// не косметика: по ним trees.js разбирает пак на варианты и кольца LOD.
const nodes = doc.getRoot().listNodes().map((n) => n.getName());
const lods = nodes.filter((n) => /^Pine_.+_LOD\d$/.test(n)).length;
const mats = doc.getRoot().listMaterials().map((m) => m.getName());
if (lods !== 45 || !mats.includes('Bark_Mat') || !mats.includes('Clusters_Mat')) {
  throw new Error(`перепаковка сломала пак: LOD-узлов ${lods}, материалы [${mats}]`);
}

await io.write(SRC, doc);
const after = fs.statSync(BIN).size;
console.log(
  `scene.bin ${(before / 1024).toFixed(0)}K -> ${(after / 1024).toFixed(0)}K ` +
    `(LOD-узлов ${lods}, материалы ${mats.join('/')})`
);
