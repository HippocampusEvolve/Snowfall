import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { snowTint } from './snowtint.js';

// Домик: Scandinavian Log Cabin (rivetech, CC-BY). Масштаб к реальным метрам,
// посадка в снег по рельефу, снег на крыше и кромках брёвен через snowTint.
// Уют: стёкла окон заменяем тёплым emissive (его ловит bloom), а у каждого
// окна снаружи ставим слабый PointLight — свет «из окна» ложится на снег.

const LENGTH = 7.4; // длина домика по большей стороне, м

export async function createCabin(terrain, { x, z, rotY = 0 } = {}) {
  const gltf = await new GLTFLoader().loadAsync('/models/cabin/scene.gltf');
  const root = gltf.scene;

  // нормализация: большая сторона = LENGTH, центр XZ в нуле, пол на y=0
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const s = LENGTH / Math.max(size.x, size.z);
  root.scale.setScalar(s);
  root.position.set(
    -s * (box.min.x + box.max.x) / 2,
    -s * box.min.y,
    -s * (box.min.z + box.max.z) / 2
  );
  const half = new THREE.Vector2((size.x * s) / 2, (size.z * s) / 2);

  const group = new THREE.Group();
  group.add(root);

  // ---- материалы: тени, снег, тёплые окна ----
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x140b04,
    emissive: 0xffb056,
    emissiveIntensity: 2.4,
    roughness: 0.35,
  });
  const glassMeshes = [];
  const tinted = new Set();
  root.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true;
    c.receiveShadow = true;
    const name = c.material?.name || '';
    if (name === 'WindowGlass') {
      c.material = glassMat;
      glassMeshes.push(c);
      return;
    }
    if (tinted.has(c.material)) return;
    tinted.add(c.material);
    if (name === 'Roof') snowTint(c.material, '0.85, 0.89, 0.98', 1.0, 0.1, { geoNormal: true });
    else snowTint(c.material, '0.78, 0.83, 0.94', 0.5, 0.5);
  });

  // ---- посадка: минимум рельефа под углами футпринта, чуть утопить ----
  const cos = Math.cos(rotY), sin = Math.sin(rotY);
  let ground = terrain.getHeight(x, z);
  for (const [cx, cz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const wx = x + (cx * half.x * cos + cz * half.y * sin);
    const wz = z + (-cx * half.x * sin + cz * half.y * cos);
    ground = Math.min(ground, terrain.getHeight(wx, wz));
  }
  group.position.set(x, ground - 0.15, z);
  group.rotation.y = rotY;
  group.updateMatrixWorld(true);

  // ---- свет из окон: кластеризуем вершины стёкол на отдельные окна ----
  const lights = [];
  const centre = new THREE.Vector3();
  group.getWorldPosition(centre);
  const clusters = [];
  const v = new THREE.Vector3();
  for (const m of glassMeshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      let c = clusters.find((c) => c.p.distanceToSquared(v) < 1.3 * 1.3);
      if (!c) {
        c = { p: v.clone(), n: 1 };
        clusters.push(c);
      } else {
        c.p.lerp(v, 1 / ++c.n); // бегущее среднее
      }
    }
  }
  const out = new THREE.Vector3();
  for (const c of clusters) {
    // наружу — от вертикальной оси домика через центр окна
    out.copy(c.p).sub(centre).setY(0);
    if (out.lengthSq() < 1e-4) continue;
    out.normalize();
    const l = new THREE.PointLight(0xffa550, 4.5, 7.5, 2);
    l.position.copy(c.p).addScaledVector(out, 0.85);
    l.position.y = Math.max(c.p.y - 0.4, ground + 0.7);
    lights.push(l);
    group.attach(l);
  }

  // ---- коллизия: три круга вдоль длинной оси ----
  const obstacles = [];
  const longHalf = Math.max(half.x, half.y);
  const shortHalf = Math.min(half.x, half.y);
  const axis = half.x >= half.y ? [cos, -sin] : [sin, cos]; // мировое направление длинной оси
  for (const t of [-0.55, 0, 0.55]) {
    obstacles.push({
      x: x + axis[0] * longHalf * t,
      z: z + axis[1] * longHalf * t,
      r: shortHalf + 0.35,
    });
  }

  // мягкое «печное» дыхание света в окнах
  function update(t) {
    const k = 0.9 + 0.06 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 3.9 + 1.2);
    glassMat.emissiveIntensity = 2.4 * k;
    for (const l of lights) l.intensity = 4.5 * k;
  }

  return { group, obstacles, update };
}
