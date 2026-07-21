import * as THREE from 'three';

// Следы на снегу: отпечатки штампуются в render target (карта следов),
// который семплируется шейдерами снега. Со временем снег заметает следы.
//
// ДВЕ карты:
//  1) ОБЩАЯ (RES на area 160 м, ~12.8 тексель/м) — память мира: тропы,
//     проталины, дальние цепочки. Отпечаток здесь — лишь пятно в 3–5 текселей,
//     деталей физически не бывает.
//  2) ДЕТАЛЬНАЯ (HI_RES на окно HI_AREA вокруг игрока, ~85 тексель/м) — в ней
//     живут протектор ботинка и лапки зверей. Окно едет за игроком:
//     при перецентровке старое содержимое копируется со сдвигом, а штампы,
//     оказавшиеся в свежеоткрытой полосе, воспроизводятся из ИСТОРИИ штампов
//     (с ослаблением по возрасту) — подойдя к дальней цепочке заячьих следов,
//     видишь чёткие лапки, хотя клались они за пределами окна.
//
// Каналы общей карты (память ног, VISION.md):
//   R — свежий след: глубокий, заметается за минуты;
//   G — УТОПТАННОСТЬ: каждый шаг добавляет немного (PACK за штамп), выцветает
//       в десятки раз медленнее. Шейдеры снега берут max(R, G).
// Детальная карта — только R (тропы крупнее её масштаба).
// Затухание — поканальное: fade-квад умножает буфер на свой ЦВЕТ
// (blendDst = SrcColorFactor), а не на общий альфа-коэффициент.
const RES = 2048;
const PACK = 0.26; // доля утоптанности за один штамп (~4 прохода до полной тропы)
const FADE_R = 0.9975; // затухание свежего следа за тик (как раньше)
const FADE_G = 0.99988; // тропа: живёт десятки минут
const SNAP = 384; // разрешение снапшота для сохранения (см. snapshot/restore)

const HI_RES = 2048; // детальная карта
const HI_AREA = 24; // окно детальной карты, м (~85 тексель/м)
const HI_HALF = HI_AREA / 2;
const RECENTER = 3; // сдвиг игрока от центра окна, после которого перецентровка
const GRID = 2; // центр окна снепится к сетке, м (реже перецентровки)
const HIST_MAX = 2600; // предел истории штампов
const HIST_TTL = 1300; // тиков fade (~5.4 мин): дальше след неразличим (R→0.04)

// мягкий радиальный градиент для лапок и кружков
function grd(ctx, x, y, r, a = 1) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(255,255,255,${0.9 * a})`);
  g.addColorStop(0.6, `rgba(255,255,255,${0.55 * a})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  return g;
}

function canvasTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

// лёгкое размытие «снежной крошки»: чёткий рисунок чуть плывёт, как в жизни —
// кромка отпечатка в снегу всегда осыпается
function blurred(c, px = 1) {
  const c2 = document.createElement('canvas');
  c2.width = c.width;
  c2.height = c.height;
  const x = c2.getContext('2d');
  x.filter = `blur(${px}px)`;
  x.drawImage(c, 0, 0);
  return c2;
}

// Подошва зимнего ботинка с протектором (носок вверх). Яркость = глубина:
// мягкое общее вдавливание + глубокие грунтозацепы. В общей карте текстура
// сминается в боти́ночное пятно, в детальной протектор читается целиком.
function makeBootTexture() {
  const W = 128;
  const H = 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');

  // силуэт подошвы: округлый носок, лёгкая талия, каблук (правая нога)
  const sole = new Path2D();
  sole.moveTo(64, 6);
  sole.bezierCurveTo(98, 6, 112, 30, 112, 62);
  sole.bezierCurveTo(112, 88, 104, 106, 97, 118);
  sole.bezierCurveTo(91, 128, 91, 132, 95, 142);
  sole.bezierCurveTo(102, 152, 104, 164, 100, 178);
  sole.bezierCurveTo(96, 192, 79, 197, 64, 197);
  sole.bezierCurveTo(49, 197, 33, 192, 29, 178);
  sole.bezierCurveTo(25, 164, 27, 152, 34, 142);
  sole.bezierCurveTo(38, 132, 38, 128, 32, 118);
  sole.bezierCurveTo(25, 106, 16, 88, 16, 62);
  sole.bezierCurveTo(16, 30, 30, 6, 64, 6);
  sole.closePath();

  x.save();
  x.clip(sole);

  // общее вдавливание подошвы
  const base = x.createRadialGradient(64, 95, 10, 64, 100, 115);
  base.addColorStop(0, 'rgba(255,255,255,0.48)');
  base.addColorStop(1, 'rgba(255,255,255,0.30)');
  x.fillStyle = base;
  x.fill(sole);

  // грунтозацепы — вдавлены глубже
  x.fillStyle = 'rgba(255,255,255,0.95)';
  const bar = (bx, by, w, h, ang) => {
    x.save();
    x.translate(bx, by);
    x.rotate(ang);
    x.beginPath();
    x.roundRect(-w / 2, -h / 2, w, h, 3.5);
    x.fill();
    x.restore();
  };
  // шевроны на носке (5 рядов)
  for (let i = 0; i < 5; i++) {
    const y = 24 + i * 19;
    bar(43, y + 4, 42, 9, 0.33);
    bar(85, y + 4, 42, 9, -0.33);
  }
  bar(64, 131, 44, 8, 0); // талия — одна поперечная планка
  for (let i = 0; i < 3; i++) bar(64, 151 + i * 16, 58, 9, 0); // каблук
  x.restore();

  return canvasTex(blurred(c, 1));
}

// Лапки зверей (нос «вверх» — та же конвенция поворота, что у ботинка)
function makeHareHindTexture() {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 96;
  const x = c.getContext('2d');
  // длинная плюсна задней лапы
  x.fillStyle = grd(x, 24, 54, 34);
  x.save();
  x.translate(24, 54);
  x.scale(0.42, 1);
  x.beginPath();
  x.arc(0, 0, 34, 0, Math.PI * 2);
  x.fill();
  x.restore();
  // пальцы у носка
  x.fillStyle = grd(x, 17, 16, 8, 0.85);
  x.fillRect(9, 8, 16, 16);
  x.fillStyle = grd(x, 31, 16, 8, 0.85);
  x.fillRect(23, 8, 16, 16);
  return canvasTex(blurred(c, 0.8));
}

function makeHareFrontTexture() {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const x = c.getContext('2d');
  x.fillStyle = grd(x, 16, 16, 13);
  x.fillRect(0, 0, 32, 32);
  return canvasTex(blurred(c, 0.8));
}

function makeFoxTexture() {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 64;
  const x = c.getContext('2d');
  // четыре пальца
  const toe = (tx, ty) => {
    x.fillStyle = grd(x, tx, ty, 7, 0.9);
    x.fillRect(tx - 8, ty - 8, 16, 16);
  };
  toe(17, 12);
  toe(31, 12);
  toe(10, 26);
  toe(38, 26);
  // задняя подушечка
  x.fillStyle = grd(x, 24, 46, 13, 0.95);
  x.save();
  x.translate(24, 46);
  x.scale(1, 0.8);
  x.beginPath();
  x.arc(0, 0, 13, 0, Math.PI * 2);
  x.fill();
  x.restore();
  return canvasTex(blurred(c, 0.8));
}

// мягкий круг (проталина, вмятина приземления)
function makeCircleTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const cg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  cg.addColorStop(0, 'rgba(255,255,255,1)');
  cg.addColorStop(0.35, 'rgba(255,255,255,0.9)');
  cg.addColorStop(0.55, 'rgba(255,255,255,0.62)');
  cg.addColorStop(0.75, 'rgba(255,255,255,0.3)');
  cg.addColorStop(0.9, 'rgba(255,255,255,0.1)');
  cg.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = cg;
  ctx.fillRect(0, 0, 128, 128);
  return canvasTex(c);
}

// стирающий круг: ЧЁРНЫЙ центр → белый край. Рисуется блендингом dst *= src,
// т.е. в центре карта следов обнуляется, к краю — нетронута. Им копание
// «снимает» следы вместе с поверхностью, на которой они были.
function makeEraseTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  const cg = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  cg.addColorStop(0, 'rgba(0,0,0,1)');
  cg.addColorStop(0.62, 'rgba(0,0,0,0.95)');
  cg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = cg;
  ctx.fillRect(0, 0, 128, 128);
  return canvasTex(c);
}

function makeRT(res) {
  const rt = new THREE.WebGLRenderTarget(res, res, {
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.generateMipmaps = false;
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  return { rt, cleared: false };
}

export class Footprints {
  constructor(renderer, area = 160) {
    this.renderer = renderer;
    this.area = area;

    this._coarse = makeRT(RES);
    this._hi = makeRT(HI_RES);
    this._hi2 = makeRT(HI_RES); // пинг-понг для сдвига окна

    const h = area / 2;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-h, h, h, -h, 0.1, 10);
    this.cam.position.z = 5;
    this.hiCam = new THREE.OrthographicCamera(-HI_HALF, HI_HALF, HI_HALF, -HI_HALF, 0.1, 10);
    this.hiCam.position.z = 5;

    // униформы для шейдеров снега: живые объекты, значения мутируются на месте
    // (материалы держат ссылки — свап пинг-понга и переезд окна доходят сами)
    this.hiUniform = { value: this._hi.rt.texture };
    this.hiCenterUniform = { value: new THREE.Vector2(9e9, 9e9) }; // окно «выключено»
    this.hiArea = HI_AREA;
    this._center = null; // мировой центр окна (null до первого updateView)

    this.tick = 0; // счётчик fade-тиков — возраст штампов в истории
    this.history = []; // {k, x, z, rot|r, side|type|s, t} — для перештамповки

    const stampMat = (map) =>
      new THREE.MeshBasicMaterial({
        map,
        color: new THREE.Color(1, PACK, 0),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      });

    // штампы (аддитивно — повторные шаги углубляют след);
    // цвет = (1, PACK, 0): R получает полный след, G — крупицу утоптанности
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(0.27, 0.42), stampMat(makeBootTexture()));
    this.pawQuads = {
      hareHind: new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.155), stampMat(makeHareHindTexture())),
      hareFront: new THREE.Mesh(new THREE.PlaneGeometry(0.055, 0.055), stampMat(makeHareFrontTexture())),
      fox: new THREE.Mesh(new THREE.PlaneGeometry(0.06, 0.08), stampMat(makeFoxTexture())),
    };
    this.circleQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), stampMat(makeCircleTexture()));

    // стирание: dst *= цвет текстуры (чёрный центр обнуляет карту)
    this.eraseQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: makeEraseTexture(),
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        depthTest: false,
        depthWrite: false,
      })
    );

    // затухание — «снег заметает следы»: dst *= цвет квада, ПОКАНАЛЬНО.
    // R (свежий след) тает быстро, G (тропа) — в десятки раз медленнее
    this.fadeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(area, area),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(FADE_R, FADE_G, 1),
        transparent: true,
        opacity: 1,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
        depthTest: false,
        depthWrite: false,
      })
    );

    // копирование окна при перецентровке (NoBlending: перенос как есть)
    this.hiCopyQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(HI_AREA, HI_AREA),
      new THREE.MeshBasicMaterial({ blending: THREE.NoBlending, depthTest: false, depthWrite: false })
    );

    this._stamps = [
      this.quad,
      this.pawQuads.hareHind,
      this.pawQuads.hareFront,
      this.pawQuads.fox,
      this.circleQuad,
      this.eraseQuad,
      this.fadeQuad,
      this.hiCopyQuad,
    ];
    for (const m of this._stamps) {
      m.visible = false;
      this.scene.add(m);
    }

    // детальные карты чистим сразу: до первого штампа в них не должно быть мусора
    this._renderTo(this._hi, this.hiCam);
    this._renderTo(this._hi2, this.hiCam);
  }

  get texture() {
    return this._coarse.rt.texture;
  }

  _renderTo(target, cam) {
    const r = this.renderer;
    const oldRT = r.getRenderTarget();
    const oldAC = r.autoClear;
    r.setRenderTarget(target.rt);
    if (!target.cleared) {
      r.setClearColor(0x000000, 1);
      r.clear();
      target.cleared = true;
    }
    r.autoClear = false;
    r.render(this.scene, cam);
    r.setRenderTarget(oldRT);
    r.autoClear = oldAC;
  }

  _showOnly(mesh) {
    for (const m of this._stamps) m.visible = m === mesh;
  }

  _inWindow(x, z, pad = 0.6) {
    const c = this._center;
    if (!c) return false;
    return Math.max(Math.abs(x - c.x), Math.abs(z - c.z)) < HI_HALF + pad;
  }

  // общий путь штампа: в общую карту цветом (1, PACK, 0), в детальную — (1,0,0)
  // (тропы в детальной не копятся — их масштаб крупнее окна). k — ослабление
  // по возрасту при перештамповке; hiOnly — только в детальную (перештамповка).
  _stampMesh(mesh, wx, wz, k = 1, hiOnly = false) {
    const mat = mesh.material;
    mat.opacity = k;
    this._showOnly(mesh);
    if (!hiOnly) {
      mat.color.setRGB(1, PACK, 0);
      this._renderTo(this._coarse, this.cam);
    }
    if (this._inWindow(wx, wz)) {
      mat.color.setRGB(1, 0, 0);
      this._renderTo(this._hi, this.hiCam);
    }
    mat.color.setRGB(1, PACK, 0);
    mat.opacity = 1;
    mesh.visible = false;
  }

  _pushHist(e) {
    e.t = this.tick;
    this.history.push(e);
    if (this.history.length > HIST_MAX) this.history.splice(0, this.history.length - HIST_MAX);
  }

  _placeBoot(x, z, rot, side) {
    this.quad.position.set(x, -z, 0);
    this.quad.rotation.z = rot;
    this.quad.scale.set(side, 1, 1); // зеркалим подошву для левой/правой ноги
  }

  // x, z — мировые координаты; dir — направление движения; side — -1/1 (левая/правая)
  stamp(x, z, dir, side) {
    const rot = Math.atan2(-dir.x, -dir.z); // мир (x, z) -> сцена штампа (x, -z)
    this._placeBoot(x, z, rot, side);
    this._stampMesh(this.quad, x, z);
    this._pushHist({ k: 0, x, z, rot, side });
  }

  // лапка зверя: type — 'hareHind' | 'hareFront' | 'fox'; heading — курс, рад
  stampPaw(x, z, heading, type) {
    const mesh = this.pawQuads[type];
    const rot = Math.atan2(-Math.cos(heading), -Math.sin(heading));
    mesh.position.set(x, -z, 0);
    mesh.rotation.z = rot;
    this._stampMesh(mesh, x, z);
    this._pushHist({ k: 1, x, z, rot, type });
  }

  // круглая проталина (x, z — мир; radius — м; strength — 0..1 за штамп)
  stampCircle(x, z, radius, strength = 1) {
    this.circleQuad.position.set(x, -z, 0);
    this.circleQuad.scale.set(radius * 2, radius * 2, 1);
    this._stampMesh(this.circleQuad, x, z, strength);
    // слабые повторяющиеся штампы (проталина костра) историю не засоряют:
    // они сами возобновляются, пока источник жив
    if (strength >= 0.15) this._pushHist({ k: 2, x, z, r: radius, s: strength });
  }

  // стереть следы в круге (копание/намыв сняли поверхность вместе с ними)
  eraseCircle(x, z, radius) {
    this.eraseQuad.position.set(x, -z, 0);
    this.eraseQuad.scale.set(radius * 2, radius * 2, 1);
    this._showOnly(this.eraseQuad);
    this._renderTo(this._coarse, this.cam);
    if (this._inWindow(x, z)) this._renderTo(this._hi, this.hiCam);
    this.eraseQuad.visible = false;
    // из истории тоже: иначе перештамповка окна воскресила бы стёртое
    const r2 = radius * radius * 0.8;
    this.history = this.history.filter((e) => {
      const dx = e.x - x;
      const dz = e.z - z;
      return dx * dx + dz * dz > r2;
    });
  }

  // перештамповка одной записи истории в детальную карту (с ослаблением k)
  _restampHi(e, k) {
    if (e.k === 0) {
      this._placeBoot(e.x, e.z, e.rot, e.side);
      this._stampMesh(this.quad, e.x, e.z, k, true);
    } else if (e.k === 1) {
      const mesh = this.pawQuads[e.type];
      mesh.position.set(e.x, -e.z, 0);
      mesh.rotation.z = e.rot;
      this._stampMesh(mesh, e.x, e.z, k, true);
    } else {
      this.circleQuad.position.set(e.x, -e.z, 0);
      this.circleQuad.scale.set(e.r * 2, e.r * 2, 1);
      this._stampMesh(this.circleQuad, e.x, e.z, e.s * k, true);
    }
  }

  // Ведение окна детальной карты за игроком (звать каждый кадр — дёшево:
  // работа происходит только при перецентровке, раз в несколько метров пути)
  updateView(px, pz) {
    const snap = (v) => Math.round(v / GRID) * GRID;
    if (!this._center) {
      this._center = new THREE.Vector2(snap(px), snap(pz));
      this.hiCam.position.set(this._center.x, -this._center.y, 5);
      this.hiCenterUniform.value.copy(this._center);
      return;
    }
    const c = this._center;
    if (Math.max(Math.abs(px - c.x), Math.abs(pz - c.y)) <= RECENTER) return;
    const nx = snap(px);
    const nz = snap(pz);
    if (nx === c.x && nz === c.y) return;

    // копируем старое окно со сдвигом в свободный буфер
    const src = this._hi;
    const dst = this._hi2;
    this.hiCopyQuad.material.map = src.rt.texture;
    this.hiCopyQuad.material.needsUpdate = true;
    this.hiCopyQuad.position.set(c.x, -c.y, 0);
    this.hiCam.position.set(nx, -nz, 5);
    dst.cleared = false; // принудительная очистка перед копией
    this._showOnly(this.hiCopyQuad);
    this._renderTo(dst, this.hiCam);
    this.hiCopyQuad.visible = false;

    this._hi = dst;
    this._hi2 = src;
    this.hiUniform.value = this._hi.rt.texture;

    const ox = c.x;
    const oz = c.y;
    c.set(nx, nz);
    this.hiCenterUniform.value.copy(c);

    // свежеоткрытая полоса окна: воспроизводим из истории с ослаблением по возрасту
    for (const e of this.history) {
      const inNew = Math.max(Math.abs(e.x - nx), Math.abs(e.z - nz)) < HI_HALF;
      if (!inNew) continue;
      const inOld = Math.max(Math.abs(e.x - ox), Math.abs(e.z - oz)) < HI_HALF;
      if (inOld) continue; // уже перенесено копией
      const k = Math.pow(FADE_R, this.tick - e.t);
      if (k < 0.05) continue;
      this._restampHi(e, k);
    }
  }

  fade() {
    this._showOnly(this.fadeQuad);
    this.fadeQuad.position.set(0, 0, 0);
    this._renderTo(this._coarse, this.cam);
    if (this._center) {
      this.fadeQuad.position.set(this._center.x, -this._center.y, 0);
      this._renderTo(this._hi, this.hiCam);
    }
    this.fadeQuad.visible = false;
    this.tick++;
    // изредка чистим историю от неразличимо-старых штампов
    if (this.tick % 40 === 0 && this.history.length) {
      const cut = this.tick - HIST_TTL;
      this.history = this.history.filter((e) => e.t > cut);
    }
  }

  // ---- сохранение мира: снапшот общей карты и её восстановление ----
  // Карта уменьшается до SNAP² (отдельный RT + readPixels): отдельные отпечатки
  // размываются, но тропы (G), проталины и вмятины переживают перезагрузку.
  // Детальная карта не сохраняется: свежие следы (R) к следующему запуску
  // всё равно замело бы.
  _ensureIO() {
    if (this.ioQuad) return;
    this.snapRT = new THREE.WebGLRenderTarget(SNAP, SNAP, {
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    // квад на всю область: копирование текстуры через обычный рендер той же камерой
    this.ioQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(this.area, this.area),
      new THREE.MeshBasicMaterial({ blending: THREE.NoBlending, depthTest: false, depthWrite: false })
    );
    this.ioQuad.visible = false;
    this.scene.add(this.ioQuad);
    this._stamps.push(this.ioQuad);
  }

  snapshot() {
    this._ensureIO();
    const r = this.renderer;
    this.ioQuad.material.map = this._coarse.rt.texture;
    this.ioQuad.material.needsUpdate = true;
    this._showOnly(this.ioQuad);
    const oldRT = r.getRenderTarget();
    r.setRenderTarget(this.snapRT);
    r.render(this.scene, this.cam);
    const data = new Uint8Array(SNAP * SNAP * 4);
    r.readRenderTargetPixels(this.snapRT, 0, 0, SNAP, SNAP, data);
    r.setRenderTarget(oldRT);
    this.ioQuad.visible = false;
    return data;
  }

  // То же, но чтение пикселей — асинхронное (PBO + fence), без стойла GPU
  // в кадре: рендер уменьшенной карты в snapRT синхронный и дешёвый, а
  // readback приезжает промисом через кадр-два. snapRT больше никем не
  // трогается до следующего снапшота, так что данные не гоняются.
  async snapshotAsync() {
    this._ensureIO();
    const r = this.renderer;
    this.ioQuad.material.map = this._coarse.rt.texture;
    this.ioQuad.material.needsUpdate = true;
    this._showOnly(this.ioQuad);
    const oldRT = r.getRenderTarget();
    r.setRenderTarget(this.snapRT);
    r.render(this.scene, this.cam);
    r.setRenderTarget(oldRT);
    this.ioQuad.visible = false;
    const data = new Uint8Array(SNAP * SNAP * 4);
    await r.readRenderTargetPixelsAsync(this.snapRT, 0, 0, SNAP, SNAP, data);
    return data;
  }

  restore(data) {
    this._ensureIO();
    const tex = new THREE.DataTexture(data, SNAP, SNAP, THREE.RGBAFormat);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.ioQuad.material.map = tex;
    this.ioQuad.material.needsUpdate = true;
    this._showOnly(this.ioQuad);
    this._coarse.cleared = false; // очистка перед восстановлением
    this._renderTo(this._coarse, this.cam);
    this.ioQuad.visible = false;
    tex.dispose();
  }
}
