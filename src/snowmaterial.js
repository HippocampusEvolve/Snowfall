import * as THREE from 'three';

// Общий материал снега для базового террейна и деформируемого патча.
// base  — обычный меш, следы только шейдингом; дырка (discard) под патчем.
// patch — плотная сетка вокруг игрока: вершины реально вдавливаются
//         по trail-карте (высота рельефа берётся из запечённой heightmap).

const WORLD = 400; // размер террейна, м
const HN = 241; // разрешение heightmap (совпадает с сеткой террейна 240+1)
const DEPTH = 0.14; // глубина полного следа, м
const LIFT = 0.03; // патч чуть выше базового меша

// выравнивание uv по центрам текселей heightmap
const HUV_SCALE = ((HN - 1) / HN).toFixed(8);
const HUV_OFF = (0.5 / HN).toFixed(8);

export function loadSnowTextures(maxAnisotropy) {
  const tl = new THREE.TextureLoader();
  const setup = (t, srgb) => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(34, 34);
    t.anisotropy = maxAnisotropy;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  };
  return {
    map: setup(tl.load('/textures/snow_02_diff_2k.jpg'), true),
    normalMap: setup(tl.load('/textures/snow_02_nor_gl_2k.jpg')),
    roughnessMap: setup(tl.load('/textures/snow_02_rough_2k.jpg')),
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
      float sampleGround(vec2 wxz) {
        vec2 huv = (wxz / ${WORLD.toFixed(1)} + 0.5) * ${HUV_SCALE} + ${HUV_OFF};
        return texture2D(uHeight, huv).r;
      }
      float sampleTrail(vec2 wxz) {
        vec2 uv = vec2(wxz.x, -wxz.y) / uTrailArea + 0.5;
        if (any(greaterThan(abs(uv - 0.5), vec2(0.499)))) return 0.0;
        return clamp(texture2D(uTrail, uv).r, 0.0, 1.0);
      }
      float snowY(vec2 wxz) {
        return sampleGround(wxz) + ${LIFT.toFixed(3)} - sampleTrail(wxz) * ${DEPTH.toFixed(3)};
      }`;
    }
    shader.vertexShader = shader.vertexShader.replace('#include <common>', vsCommon);

    if (mode === 'patch') {
      shader.vertexShader = shader.vertexShader
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
        return texture2D(uTrail, uv).r;
      }`;
    if (mode === 'base') fsCommon += '\nuniform vec4 uPatchRect;';
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', fsCommon);

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
        }`
      );
  };

  mat.customProgramCacheKey = () => `snow-${mode}`;
  return { material: mat, uniforms };
}

export const SNOW_CONST = { WORLD, HN, DEPTH, LIFT };
