import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { asset } from './asset.js';

// Общий GLTFLoader с Draco-декодером: геометрия всех моделей сжата
// KHR_draco_mesh_compression (gltf-transform), текстуры — WebP.
// Декодер (wasm + js-фолбэк) лежит в public/draco/ — скопирован из
// node_modules/three/examples/jsm/libs/draco/gltf/.
const draco = new DRACOLoader().setDecoderPath(asset('draco/'));

export function createGLTFLoader() {
  return new GLTFLoader().setDRACOLoader(draco);
}
