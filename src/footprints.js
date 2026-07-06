import * as THREE from 'three';

// Следы на снегу: отпечатки штампуются в render target (карта следов),
// который семплируется шейдером террейна. Со временем снег заметает следы.
const RES = 2048;

function makeFootprintTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 96;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 96);

  const grd = (x, y, r) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    return g;
  };

  // носок ботинка
  ctx.fillStyle = grd(32, 30, 26);
  ctx.beginPath();
  ctx.ellipse(32, 30, 19, 26, 0, 0, Math.PI * 2);
  ctx.fill();
  // пятка
  ctx.fillStyle = grd(32, 74, 17);
  ctx.beginPath();
  ctx.ellipse(32, 74, 13, 16, 0, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

export class Footprints {
  constructor(renderer, area = 160) {
    this.renderer = renderer;
    this.area = area;

    this.rt = new THREE.WebGLRenderTarget(RES, RES, {
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this.rt.texture.generateMipmaps = false;
    this.rt.texture.minFilter = THREE.LinearFilter;
    this.rt.texture.magFilter = THREE.LinearFilter;

    const h = area / 2;
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-h, h, h, -h, 0.1, 10);
    this.cam.position.z = 5;

    // штамп отпечатка (аддитивно — повторные шаги углубляют след)
    this.quad = new THREE.Mesh(
      new THREE.PlaneGeometry(0.27, 0.42),
      new THREE.MeshBasicMaterial({
        map: makeFootprintTexture(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.scene.add(this.quad);

    // затухание — «снег заметает следы» (умножение буфера на коэффициент)
    this.fadeQuad = new THREE.Mesh(
      new THREE.PlaneGeometry(area, area),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.9975,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcAlphaFactor,
        depthTest: false,
        depthWrite: false,
      })
    );
    this.fadeQuad.visible = false;
    this.scene.add(this.fadeQuad);

    this.cleared = false;
  }

  get texture() {
    return this.rt.texture;
  }

  _render() {
    const r = this.renderer;
    const oldRT = r.getRenderTarget();
    const oldAC = r.autoClear;
    r.setRenderTarget(this.rt);
    if (!this.cleared) {
      r.setClearColor(0x000000, 1);
      r.clear();
      this.cleared = true;
    }
    r.autoClear = false;
    r.render(this.scene, this.cam);
    r.setRenderTarget(oldRT);
    r.autoClear = oldAC;
  }

  // x, z — мировые координаты; dir — направление движения; side — -1/1 (левая/правая)
  stamp(x, z, dir, side) {
    // мир (x, z) -> сцена штампа (x, -z)
    this.quad.position.set(x, -z, 0);
    this.quad.rotation.z = Math.atan2(-dir.x, -dir.z);
    this.quad.scale.x = side; // зеркалим подошву для левой/правой ноги
    this.quad.visible = true;
    this.fadeQuad.visible = false;
    this._render();
  }

  fade() {
    this.quad.visible = false;
    this.fadeQuad.visible = true;
    this._render();
    this.fadeQuad.visible = false;
  }
}
