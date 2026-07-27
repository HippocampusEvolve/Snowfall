// Камни Quaternius приезжали пятью сырыми .fbx (164 КБ мимо gzip) и тянули в
// бандл целый FBXLoader. Здесь они разбираются один раз на сборке и
// складываются в один models/nature/rocks.glb — его читает общий GLTFLoader.
//
// Разовый инструмент, в зависимостях проекта не держим:
//   npm i -D @gltf-transform/core @gltf-transform/extensions \
//            @gltf-transform/functions draco3dgltf
//   node tools/rocks-to-glb.mjs
// Исходные Rock_1..5.fbx удалены после конвертации — они в истории git.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression } from '@gltf-transform/extensions';
import { draco } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';

// GLTFExporter рассчитан на браузер и склеивает .glb через FileReader — в node
// его нет, подставляем минимальную замену поверх Blob.arrayBuffer().
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((ab) => {
      this.result = ab;
      this.onloadend?.();
    });
  }
};

const SRC = 'public/models/nature';
const OUT = path.join(SRC, 'rocks.glb');
const NAMES = ['Rock_1', 'Rock_2', 'Rock_3', 'Rock_4', 'Rock_5'];

const loader = new FBXLoader();
const root = new THREE.Group();
root.name = 'Rocks';

for (const name of NAMES) {
  const buf = fs.readFileSync(path.join(SRC, `${name}.fbx`));
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const fbx = loader.parse(ab, '');

  // Схлопываем иерархию FBX в один меш на камень: trees.js всё равно берёт
  // только геометрию в мировом пространстве и нормализует её сам.
  fbx.updateMatrixWorld(true);
  const holder = new THREE.Group();
  holder.name = name;
  fbx.traverse((child) => {
    if (!child.isMesh) return;
    const geo = child.geometry.clone().applyMatrix4(child.matrixWorld);
    // цвета вершин и лишние атрибуты паку не нужны — только форма и нормаль
    for (const attr of Object.keys(geo.attributes)) {
      if (attr !== 'position' && attr !== 'normal') geo.deleteAttribute(attr);
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    holder.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  });
  root.add(holder);
  console.log(`${name}: мешей ${holder.children.length}`);
}

const glb = await new GLTFExporter().parseAsync(root, { binary: true, onlyVisible: false });

// Draco поверх экспорта — тем же способом, что сжаты домик и сосны, так что
// на клиенте всё читает один GLTFLoader с уже подключённым декодером.
const io = new NodeIO()
  .registerExtensions([KHRDracoMeshCompression])
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  });
const doc = await io.readBinary(new Uint8Array(glb));
await doc.transform(draco());
const packed = await io.writeBinary(doc);
fs.writeFileSync(OUT, Buffer.from(packed));

const oldSize = NAMES.reduce((s, n) => s + fs.statSync(path.join(SRC, `${n}.fbx`)).size, 0);
console.log(
  `\n${(oldSize / 1024).toFixed(0)}K (5 × .fbx) -> ${(glb.byteLength / 1024).toFixed(0)}K (glb) -> ` +
    `${(packed.byteLength / 1024).toFixed(0)}K (draco, ${OUT})`
);
