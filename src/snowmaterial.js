import * as THREE from 'three';
import { asset } from './asset.js';

// Общий материал снега для базового террейна и деформируемого патча.
// base  — обычный меш, следы только шейдингом; дырка (discard) под патчем.
// patch — плотная сетка вокруг игрока: вершины реально вдавливаются
//         по trail-карте (высота рельефа берётся из запечённой heightmap).

const WORLD = 400; // размер террейна, м
const HN = 241; // разрешение heightmap (совпадает с сеткой террейна 240+1)
const DEPTH = 0.14; // глубина полного следа, м
const LIFT = 0.03; // патч чуть выше базового меша
const REPEAT = 34; // повторов текстуры снега на весь террейн
const CUTCOL = 4.0; // колонка coverage-выреза копания (= чанк Digger), м
const CUTFADE = 0.5; // ширина гашения вдавливания следов у границы выреза, м

// выравнивание uv по центрам текселей heightmap
const HUV_SCALE = ((HN - 1) / HN).toFixed(8);
const HUV_OFF = (0.5 / HN).toFixed(8);

// дефолтная (пустая) coverage-маска: пока не копаем — ничего не вырезаем
let DEFAULT_CUT = null;
function defaultCutTex() {
  if (!DEFAULT_CUT) {
    DEFAULT_CUT = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    DEFAULT_CUT.needsUpdate = true;
  }
  return DEFAULT_CUT;
}

export function loadSnowTextures(maxAnisotropy) {
  const tl = new THREE.TextureLoader();
  const setup = (t, srgb) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(REPEAT, REPEAT);
    t.anisotropy = maxAnisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    map: setup(tl.load(asset('textures/snow_02_diff_2k.webp')), true),
    normalMap: setup(tl.load(asset('textures/snow_02_nor_gl_1k.webp'))),
    roughnessMap: setup(tl.load(asset('textures/snow_02_rough_2k.webp'))),
  };
}

export function createSnowMaterial({ footprints, textures, mode, heightTex = null }) {
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.85, 0.88, 0.96),
    map: textures.map,
    normalMap: textures.normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughnessMap: textures.roughnessMap,
    roughness: 1.0,
    metalness: 0.0,
  });

  const uniforms = {
    uTrail: { value: footprints.texture },
    uTrailArea: { value: footprints.area },
    // детальная карта следов (окно вокруг игрока): протектор ботинка, лапки.
    // Объекты униформ разделяются с Footprints — свап пинг-понга и переезд
    // окна доходят до шейдера без ручной рассылки
    uTrailHi: footprints.hiUniform,
    uTrailHiC: footprints.hiCenterUniform,
    uTrailHiArea: { value: footprints.hiArea },
    // coverage-маска воксельного копания (Digger): дырку под мешем вырезаем discard'ом
    uCut: { value: defaultCutTex() },
    uCutArea: { value: WORLD },
    uCutOn: { value: 0 },
  };
  if (mode === 'base') {
    // прямоугольник, накрытый патчем: minX, minZ, maxX, maxZ
    uniforms.uPatchRect = { value: new THREE.Vector4(9e9, 9e9, 9e9, 9e9) };
  } else {
    uniforms.uHeight = { value: heightTex };
  }

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // ---------- vertex ----------
    let vsCommon = `#include <common>
      varying vec3 vWp;`;
    if (mode === 'patch') {
      vsCommon += `
      uniform sampler2D uHeight;
      uniform sampler2D uTrail;
      uniform float uTrailArea;
      uniform sampler2D uCut;
      uniform float uCutArea;
      uniform float uCutOn;
      float sampleGround(vec2 wxz) {
        vec2 huv = (wxz / ${WORLD.toFixed(1)} + 0.5) * ${HUV_SCALE} + ${HUV_OFF};
        return texture2D(uHeight, huv).r;
      }
      float sampleTrail(vec2 wxz) {
        vec2 uv = vec2(wxz.x, -wxz.y) / uTrailArea + 0.5;
        if (any(greaterThan(abs(uv - 0.5), vec2(0.499)))) return 0.0;
        // R — свежий след, G — утоптанная тропа (заметается медленнее)
        vec2 t = texture2D(uTrail, uv).rg;
        return clamp(max(t.r, t.g), 0.0, 1.0);
      }
      float cutCol(vec2 cell) {
        vec2 c = cell * ${CUTCOL.toFixed(1)} + ${(CUTCOL / 2).toFixed(1)};
        return texture2D(uCut, c / uCutArea + 0.5).r;
      }
      // Вес вдавливания следов: 0 на границе coverage-выреза, 1 в ${CUTFADE} м
      // от неё. Кромка воксельного меша (Digger) стоит на высоте террейна и про
      // trail-карту не знает — след, продавивший патч у самой линии выреза,
      // отгибал бы его от кромки ступенькой до DEPTH. Тень следа остаётся
      // (шейдинг в fragment) — как вмятины на базовом террейне вне патча.
      // Дырку под патчем режет фрагментный discard, но вершины разделяются
      // треугольниками через границу, поэтому вес считаем и в вырезанных
      // колонках (там он 0).
      float cutFade(vec2 wxz) {
        if (uCutOn < 0.5) return 1.0;
        vec2 cell = floor(wxz / ${CUTCOL.toFixed(1)});
        if (cutCol(cell) > 0.5) return 0.0;
        vec2 f = wxz - cell * ${CUTCOL.toFixed(1)};
        vec2 g = vec2(${CUTCOL.toFixed(1)}) - f;
        float d = 1e9;
        if (cutCol(cell + vec2(-1.0, 0.0)) > 0.5) d = min(d, f.x);
        if (cutCol(cell + vec2(1.0, 0.0)) > 0.5) d = min(d, g.x);
        if (cutCol(cell + vec2(0.0, -1.0)) > 0.5) d = min(d, f.y);
        if (cutCol(cell + vec2(0.0, 1.0)) > 0.5) d = min(d, g.y);
        if (cutCol(cell + vec2(-1.0, -1.0)) > 0.5) d = min(d, length(f));
        if (cutCol(cell + vec2(1.0, -1.0)) > 0.5) d = min(d, length(vec2(g.x, f.y)));
        if (cutCol(cell + vec2(-1.0, 1.0)) > 0.5) d = min(d, length(vec2(f.x, g.y)));
        if (cutCol(cell + vec2(1.0, 1.0)) > 0.5) d = min(d, length(g));
        return smoothstep(0.0, ${CUTFADE.toFixed(2)}, d);
      }
      float snowY(vec2 wxz) {
        return sampleGround(wxz) + ${LIFT.toFixed(3)} - sampleTrail(wxz) * cutFade(wxz) * ${DEPTH.toFixed(3)};
      }`;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', vsCommon);

    if (mode === 'patch') {
      shader.vertexShader = shader.vertexShader
        // патч движется за игроком — UV текстур должны быть мировыми,
        // иначе текстура едет вместе с сеткой и не совпадает по масштабу
        // с базовым террейном (у того uv 0..1 на 400 м × repeat)
        .replace(
          '#include <uv_vertex>',
          `#include <uv_vertex>
          {
            vec2 wuv = (modelMatrix * vec4(position, 1.0)).xz * ${(REPEAT / WORLD).toFixed(8)};
            #ifdef USE_MAP
              vMapUv = wuv;
            #endif
            #ifdef USE_NORMALMAP
              vNormalMapUv = wuv;
            #endif
            #ifdef USE_ROUGHNESSMAP
              vRoughnessMapUv = wuv;
            #endif
          }`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          {
            vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
            float e = 0.22;
            float yL = snowY(wxz - vec2(e, 0.0));
            float yR = snowY(wxz + vec2(e, 0.0));
            float yB = snowY(wxz - vec2(0.0, e));
            float yF = snowY(wxz + vec2(0.0, e));
            objectNormal = normalize(vec3(yL - yR, 2.0 * e, yB - yF));
          }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          {
            vec2 wxz = (modelMatrix * vec4(position, 1.0)).xz;
            transformed.y = snowY(wxz);
            vWp = vec3(wxz.x, transformed.y, wxz.y);
          }`
        );
    } else {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;'
      );
    }

    // ---------- fragment ----------
    let fsCommon = `#include <common>
      varying vec3 vWp;
      uniform sampler2D uTrail;
      uniform float uTrailArea;
      float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      vec2 trailUv(vec3 wp) { return vec2(wp.x, -wp.z) / uTrailArea + 0.5; }
      float trailAt(vec2 uv) {
        if (any(greaterThan(abs(uv - 0.5), vec2(0.499)))) return 0.0;
        vec2 t = texture2D(uTrail, uv).rg; // R — след, G — тропа
        return max(t.r, t.g);
      }
      // детальная карта следов: окно вокруг игрока, к краю гаснет — шов
      // с общей картой не виден (общая продолжает тот же след, только мягче)
      uniform sampler2D uTrailHi;
      uniform vec2 uTrailHiC;
      uniform float uTrailHiArea;
      vec2 trailHiUv(vec3 wp) {
        return vec2(wp.x - uTrailHiC.x, uTrailHiC.y - wp.z) / uTrailHiArea + 0.5;
      }
      float trailHiFade(vec2 uv) {
        vec2 m = abs(uv - 0.5);
        return 1.0 - smoothstep(0.40, 0.485, max(m.x, m.y));
      }
      float trailHiAt(vec2 uv) {
        if (any(greaterThan(abs(uv - 0.5), vec2(0.5)))) return 0.0;
        return texture2D(uTrailHi, uv).r;
      }
      uniform sampler2D uCut;
      uniform float uCutArea;
      uniform float uCutOn;`;
    if (mode === 'base') fsCommon += '\nuniform vec4 uPatchRect;';
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', fsCommon);

    // дырка под воксельным мешем копания (для обоих режимов снега)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `if (uCutOn > 0.5 && texture2D(uCut, vec2(vWp.x, vWp.z) / uCutArea + 0.5).r > 0.5) discard;
      #include <clipping_planes_fragment>`
    );

    if (mode === 'base') {
      // дырка под деформируемым патчем
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `if (vWp.x > uPatchRect.x && vWp.z > uPatchRect.y &&
             vWp.x < uPatchRect.z && vWp.z < uPatchRect.w) discard;
        #include <clipping_planes_fragment>`
      );
    }

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // приглушаем тёмные вмятины, запечённые в текстуре — снег свежий
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.885, 0.955), 0.55);
        vec2 tuv = trailUv(vWp);
        float tr = clamp(trailAt(tuv), 0.0, 1.0);
        // вблизи след уточняется детальной картой (чёткий протектор/лапки)
        vec2 hiUv = trailHiUv(vWp);
        float hiW = trailHiFade(hiUv);
        tr = max(tr, trailHiAt(hiUv) * hiW);
        // утоптанный снег темнее и синее
        diffuseColor.rgb *= 1.0 - tr * 0.38;
        diffuseColor.b *= 1.0 + tr * 0.06;
        // искры на снегу — мерцают при движении взгляда
        float camDist = length(cameraPosition - vWp);
        vec3 vdir = normalize(cameraPosition - vWp);
        vec2 cell = floor(vWp.xz * 24.0);
        float h1 = hash21(cell);
        float tw = fract(h1 * 93.7 + dot(vdir.xz, vec2(7.3, 11.1)) + vdir.y * 5.0);
        float sparkle = step(0.985, h1) * pow(smoothstep(0.72, 1.0, tw), 4.0);
        sparkle *= (1.0 - tr) * exp(-camDist * 0.045);
        diffuseColor.rgb += sparkle * 1.4;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          float e = 1.5 / 2048.0;
          float tC = trailAt(tuv);
          float tX = trailAt(tuv + vec2(e, 0.0));
          float tY = trailAt(tuv + vec2(0.0, e));
          vec3 nOff = vec3(tX - tC, 0.0, -(tY - tC)) * ${mode === 'patch' ? '2.0' : '4.0'};
          normal = normalize(normal + (viewMatrix * vec4(nOff, 0.0)).xyz);
        }
        // рельеф протектора из детальной карты — грунтозацепы читаются светотенью
        if (hiW > 0.001) {
          float eh = 1.2 / 2048.0;
          float hC = trailHiAt(hiUv);
          float hX = trailHiAt(hiUv + vec2(eh, 0.0));
          float hY = trailHiAt(hiUv + vec2(0.0, eh));
          vec3 hOff = vec3(hX - hC, 0.0, -(hY - hC)) * 5.0 * hiW;
          normal = normalize(normal + (viewMatrix * vec4(hOff, 0.0)).xyz);
        }`
      );
  };

  mat.customProgramCacheKey = () => `snow-${mode}`;
  return { material: mat, uniforms };
}

// Материал вырытого объёма (Digger). Marching-cubes меш не имеет UV и его
// нормали смотрят во все стороны, поэтому ту же текстуру снега кладём
// ТРИПЛАНАРНО (проекции по трём мировым осям, смешанные по нормали) — в том же
// мировом масштабе, что и террейн, так что срез точно совпадает с поверхностью
// по краю ямы. Вглубь свежий снег плавно переходит в плотный фирн/лёд: темнее,
// синее, глаже, с тонкой горизонтальной слоистостью — как настоящий срез сугроба.
export function createDiggerMaterial({ textures, heightTex, footprints }) {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.DoubleSide, // видно стенки и изнутри пещеры
  });

  const SC = (REPEAT / WORLD).toFixed(8); // мировой масштаб текстуры (как у террейна)
  const uniforms = {
    uSnow: { value: textures.map },
    uSnowN: { value: textures.normalMap },
    uSnowR: { value: textures.roughnessMap },
    uHeight: { value: heightTex },
    uTrail: { value: footprints.texture },
    uTrailArea: { value: footprints.area },
    uTrailHi: footprints.hiUniform,
    uTrailHiC: footprints.hiCenterUniform,
    uTrailHiArea: { value: footprints.hiArea },
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    // ---------- vertex: мировые позиция и нормаль ----------
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n varying vec3 vWp;\n varying vec3 vWn;`)
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>\n vWn = normalize(mat3(modelMatrix) * objectNormal);`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    // ---------- fragment ----------
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
      varying vec3 vWp; varying vec3 vWn;
      uniform sampler2D uSnow; uniform sampler2D uSnowN; uniform sampler2D uSnowR;
      uniform sampler2D uHeight;
      uniform sampler2D uTrail;
      uniform float uTrailArea;
      vec2 trailUv(vec3 wp) { return vec2(wp.x, -wp.z) / uTrailArea + 0.5; }
      float trailAt(vec2 uv) {
        if (any(greaterThan(abs(uv - 0.5), vec2(0.499)))) return 0.0;
        vec2 t = texture2D(uTrail, uv).rg; // R — след, G — тропа
        return max(t.r, t.g);
      }
      uniform sampler2D uTrailHi;
      uniform vec2 uTrailHiC;
      uniform float uTrailHiArea;
      vec2 trailHiUv(vec3 wp) {
        return vec2(wp.x - uTrailHiC.x, uTrailHiC.y - wp.z) / uTrailHiArea + 0.5;
      }
      float trailHiFade(vec2 uv) {
        vec2 m = abs(uv - 0.5);
        return 1.0 - smoothstep(0.40, 0.485, max(m.x, m.y));
      }
      float trailHiAt(vec2 uv) {
        if (any(greaterThan(abs(uv - 0.5), vec2(0.5)))) return 0.0;
        return texture2D(uTrailHi, uv).r;
      }`
    );

    // диффуз: триplanar-снег + переход в фирн по глубине под поверхностью
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#include <map_fragment>
      vec3 wn0 = normalize(vWn);
      vec3 bl = pow(abs(wn0), vec3(4.0));
      bl /= (bl.x + bl.y + bl.z);
      vec2 uvX = vWp.zy * ${SC};
      vec2 uvY = vWp.xz * ${SC};
      vec2 uvZ = vWp.xy * ${SC};
      vec3 snowTex = texture2D(uSnow, uvX).rgb * bl.x
                   + texture2D(uSnow, uvY).rgb * bl.y
                   + texture2D(uSnow, uvZ).rgb * bl.z;
      // глубина под снежной поверхностью (из той же heightmap, что и террейн)
      vec2 huv = (vWp.xz / ${WORLD.toFixed(1)} + 0.5) * ${HUV_SCALE} + ${HUV_OFF};
      float groundY = texture2D(uHeight, huv).r;
      float depth = clamp(groundY - vWp.y, 0.0, 4.0);
      float wallness = 1.0 - clamp(wn0.y, 0.0, 1.0);
      float firn = clamp(depth * 0.5 + wallness * 0.35, 0.0, 1.0);
      // как у поверхности: тот же тинт материала и приглушение тёмных вмятин,
      // иначе восстановленная поверхность заметно отличается от террейна
      vec3 col = mix(snowTex * vec3(0.85, 0.88, 0.96), vec3(0.86, 0.885, 0.955), 0.55);
      // уплотнённый снег вглубь — темнее, синее, стенки холоднее
      col *= mix(1.0, 0.72, firn);
      col.b *= 1.0 + firn * 0.06;
      col = mix(col, col * vec3(0.90, 0.95, 1.08), wallness * 0.5);
      // тонкая горизонтальная слоистость на стенках — срез сугроба
      float strata = sin(depth * 7.0) * 0.5 + 0.5;
      col *= 1.0 + (strata - 0.5) * 0.08 * wallness;
      diffuseColor.rgb *= col;
      // Следы (trail-карта) живут на всём, куда можно ступить: маска trS —
      // «смотрит вверх». Дно вырытой ямы и верх намытой кучи теперь принимают
      // отпечатки (по ним ходят!), стены и потолки пещер остаются свежим
      // срезом. Старые поверхностные следы над ямой стирает eraseCircle при
      // правке — призрак следов на свежем срезе не появляется.
      vec2 tuv = trailUv(vWp);
      float trS = smoothstep(0.35, 0.75, wn0.y);
      vec2 hiUvD = trailHiUv(vWp);
      float hiWD = trailHiFade(hiUvD);
      float tr = clamp(max(trailAt(tuv), trailHiAt(hiUvD) * hiWD), 0.0, 1.0) * trS;
      // тот же тон, что у террейна: утоптанный снег темнее и синее
      diffuseColor.rgb *= 1.0 - tr * 0.38;
      diffuseColor.b *= 1.0 + tr * 0.06;
      // подповерхностное рассеяние: снег в тени светится холодным, а не чёрный.
      // несём альбедо (текстуру, слоистость) — рельеф среза виден и без прямого света.
      // Вес — по firn: на восстановленной поверхности (depth≈0, нормаль вверх) он 0,
      // и цвет совпадает с террейном, у которого такой эмиссии нет
      vec3 snowFill = diffuseColor.rgb * vec3(0.13, 0.16, 0.24) * firn;`
    );

    // мягкое свечение снега добавляем как эмиссию (после лунного/огня освещения)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\n totalEmissiveRadiance += snowFill;`
    );

    // шероховатость: тот же rough-map триplanar, глубина чуть глаже (плотнее лёд)
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>',
      `float rough = texture2D(uSnowR, uvX).g * bl.x
                  + texture2D(uSnowR, uvY).g * bl.y
                  + texture2D(uSnowR, uvZ).g * bl.z;
      float roughnessFactor = roughness * rough * mix(1.0, 0.82, firn);`
    );

    // нормали: триplanar normal-map (whiteout-смешение) для рельефа среза
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <normal_fragment_maps>',
      `vec3 nX = texture2D(uSnowN, uvX).xyz * 2.0 - 1.0;
      vec3 nY = texture2D(uSnowN, uvY).xyz * 2.0 - 1.0;
      vec3 nZ = texture2D(uSnowN, uvZ).xyz * 2.0 - 1.0;
      nX.xy *= 0.5; nY.xy *= 0.5; nZ.xy *= 0.5;
      nX = vec3(nX.xy + wn0.zy, abs(nX.z) * wn0.x);
      nY = vec3(nY.xy + wn0.xz, abs(nY.z) * wn0.y);
      nZ = vec3(nZ.xy + wn0.xy, abs(nZ.z) * wn0.z);
      vec3 wnorm = normalize(nX.zyx * bl.x + nY.xzy * bl.y + nZ.xyz * bl.z);
      normal = normalize((viewMatrix * vec4(wnorm, 0.0)).xyz);
      {
        // вмятины следов шейдингом — как на базовом террейне (там тоже без
        // геометрии); маска trS не пускает их на стены и потолки пещер
        float e = 1.5 / 2048.0;
        float tC = trailAt(tuv);
        float tX = trailAt(tuv + vec2(e, 0.0));
        float tY = trailAt(tuv + vec2(0.0, e));
        vec3 nOff = vec3(tX - tC, 0.0, -(tY - tC)) * 4.0 * trS;
        normal = normalize(normal + (viewMatrix * vec4(nOff, 0.0)).xyz);
      }
      if (hiWD > 0.001) {
        // протектор из детальной карты — и на вырытом полу тоже
        float eh = 1.2 / 2048.0;
        float hC = trailHiAt(hiUvD);
        float hX = trailHiAt(hiUvD + vec2(eh, 0.0));
        float hY = trailHiAt(hiUvD + vec2(0.0, eh));
        vec3 hOff = vec3(hX - hC, 0.0, -(hY - hC)) * 5.0 * hiWD * trS;
        normal = normalize(normal + (viewMatrix * vec4(hOff, 0.0)).xyz);
      }`
    );
  };

  mat.customProgramCacheKey = () => 'digger-snow';
  return mat;
}

export const SNOW_CONST = { WORLD, HN, DEPTH, LIFT, CUTCOL, REPEAT };
