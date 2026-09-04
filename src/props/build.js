import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { boxUV, cylinderUV } from 'world-core/materials';

// Обёртка в three над описанием деталей (parts.js): из списка примитивов
// собирается ОДИН меш на роль. Меш на роль - это и есть draw call, поэтому
// предмет с двумя ролями рисуется за два прохода, а не за двадцать.
//
// Развёртка ставится здесь же и в метрах: карты ядра пекутся под тайл в метр,
// и если оставить UV по умолчанию, у мелкой детали рисунок сожмётся в рябь.
// У коробок и цилиндров развёртку кладут boxUV/cylinderUV ядра, у камня,
// тела вращения и дуги - свои сферические и трубчатые UV, просто сжатые до
// метрового масштаба.

function geometryOf(p) {
  switch (p.kind) {
    case 'box': {
      const g = new THREE.BoxGeometry(p.w, p.h, p.d);
      boxUV(g, p.w, p.h, p.d, p.uv ?? 1, p.along);
      if (p.taper) applyTaper(g, p);
      return g;
    }
    case 'cyl': {
      const g = new THREE.CylinderGeometry(p.rTop, p.rBottom, p.h, p.seg, 1, !!p.open);
      cylinderUV(g, (p.rTop + p.rBottom) / 2, p.h, p.uv ?? 1);
      return g;
    }
    case 'ico': {
      const g = new THREE.IcosahedronGeometry(p.r, 0);
      if (p.scale) g.scale(p.scale[0], p.scale[1], p.scale[2]);
      scaleUV(g, (p.uv ?? 1) * p.r * 2);
      return g;
    }
    case 'lathe': {
      const g = new THREE.LatheGeometry(
        p.profile.map(([r, y]) => new THREE.Vector2(r, y)),
        p.seg
      );
      // Профиль задан как есть, от донышка: у тела вращения начало координат
      // там, где его поставил автор профиля, а не в середине высоты. Так же
      // считает габарит parts.js, и расхождения между счётом и сценой нет.
      const h = p.profile[p.profile.length - 1][1] - p.profile[0][1];
      const rMax = Math.max(...p.profile.map(([r]) => r));
      scaleUV(g, (p.uv ?? 1) * Math.max(h, rMax * 2));
      return g;
    }
    case 'torus': {
      const g = new THREE.TorusGeometry(p.r, p.tube, p.tubeSeg, p.arcSeg, p.arc);
      scaleUV(g, (p.uv ?? 1) * p.r * p.arc);
      return g;
    }
    default:
      throw new Error(`неизвестная деталь: ${p.kind}`);
  }
}

/** UV генератора идут 0..1 по детали - растягиваем их на её размер в метрах. */
function scaleUV(g, meters) {
  const uv = g.attributes.uv;
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * meters, uv.getY(i) * meters);
}

/** Сужение коробки вдоль оси - то же, что считает parts.js в габаритах. */
function applyTaper(g, p) {
  const t = p.taper;
  const piv = t.pivot || {};
  const px = piv.x ?? 0;
  const py = piv.y ?? 0;
  const pz = piv.z ?? 0;
  const span = t.axis === 'x' ? p.w : t.axis === 'z' ? p.d : p.h;
  const ai = t.axis === 'x' ? 0 : t.axis === 'z' ? 2 : 1;
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const q = [pos.getX(i), pos.getY(i), pos.getZ(i)];
    const u = q[ai] / span + 0.5;
    if (t.x) q[0] = (q[0] - px) * (t.x[0] + (t.x[1] - t.x[0]) * u) + px;
    if (t.y) q[1] = (q[1] - py) * (t.y[0] + (t.y[1] - t.y[0]) * u) + py;
    if (t.z) q[2] = (q[2] - pz) * (t.z[0] + (t.z[1] - t.z[0]) * u) + pz;
    pos.setXYZ(i, q[0], q[1], q[2]);
  }
  g.computeVertexNormals();
}

/**
 * Собрать группу: один меш на роль, материалы приходят снаружи (`mats`).
 *
 * `tint` у детали - вершинный цвет: так стопка книг получает разные переплёты,
 * не заводя по материалу на книгу.
 */
export function buildParts(parts, mats, o = {}) {
  const group = new THREE.Group();
  const byRole = new Map();
  for (const p of parts) {
    const g = geometryOf(p);
    if (p.rot) g.rotateZ(p.rot[2] || 0), g.rotateY(p.rot[1] || 0), g.rotateX(p.rot[0] || 0);
    g.translate(p.x, p.y, p.z);
    if (p.tint !== undefined) {
      const c = new THREE.Color(p.tint);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    if (!byRole.has(p.role)) byRole.set(p.role, []);
    byRole.get(p.role).push(g);
  }
  for (const [role, geos] of byRole) {
    const mat = mats[role];
    if (!mat) throw new Error(`нет материала для роли ${role}`);
    // Вершинный цвет живёт на геометрии, но включается материалом. Если хоть
    // одна деталь роли покрашена, атрибут нужен всем - иначе three потеряет
    // выравнивание при склейке.
    if (geos.some((g) => g.attributes.color)) {
      for (const g of geos) {
        if (g.attributes.color) continue;
        const n = g.attributes.position.count;
        const col = new Float32Array(n * 3).fill(1);
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      }
      mat.vertexColors = true;
    }
    // Склейка требует одинакового устройства: у коробки и цилиндра индекс
    // есть, у камня-икосаэдра нет. Приводим к общему, иначе mergeGeometries
    // молча вернёт null.
    let list = geos;
    if (geos.length > 1 && new Set(geos.map((g) => !!g.index)).size > 1) {
      list = geos.map((g) => (g.index ? g.toNonIndexed() : g));
    }
    const mesh = new THREE.Mesh(list.length > 1 ? mergeGeometries(list) : list[0], mat);
    mesh.name = role;
    mesh.castShadow = o.castShadow ?? true;
    mesh.receiveShadow = o.receiveShadow ?? true;
    group.add(mesh);
  }
  return group;
}
