import * as THREE from 'three';
import { SNOW_CONST } from './snowmaterial.js';

// Снежная ШАПКА: оболочка из той же геометрии, раздутая по нормали в вершинном
// шейдере; выживают только фрагменты, чья мировая нормаль смотрит вверх.
// В отличие от snowTint (белёсый налёт по поверхности) у шапки есть ТОЛЩИНА —
// наросший слой виден с ребра кровли и на верхней дуге полена. Внутрь дома
// не попадает по построению: потолок и стены смотрят нормалью вниз/вбок и
// отбрасываются. Плата: +1 draw call на меш; буферы разделяются с оригиналом.
//
// Вещество шапки — ТОТ ЖЕ снег, что на земле и на срезе ямы: та же текстура,
// положенная ТРИПЛАНАРНО (проекции по трём мировым осям, смешанные по нормали)
// в мировом масштабе террейна. Поэтому крыша, дрова, земля и стенка раскопа
// читаются как один снег — одно зерно, один тон, одни искры. Плюс своё, чего
// у плоского среза нет: мягкая, тающая к скату кромка и блёстки при движении
// взгляда.

const MATS = new Map(); // толщина → материал (толщина вшита в шейдер литералом)

// мировой масштаб текстуры — ровно как у террейна и диггера, чтобы зерно снега
// на крыше совпадало по размеру с зерном на земле под ней
const SC = (SNOW_CONST.REPEAT / SNOW_CONST.WORLD).toFixed(8);

// текстуры снега приходят из общих ассетов (loadSnowTextures) — задаются один
// раз в main через initSnowCap ДО создания сруба/поленницы. Материалы кешируются
// по толщине, текстуры глобальны, так что достаточно одного вызова.
let TEX = null;
export function initSnowCap(textures) {
  TEX = textures;
}

function capMaterial(thick) {
  const key = thick.toFixed(4);
  let m = MATS.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1.0, metalness: 0.0 });
  const uniforms = {
    uSnow: { value: TEX.map },
    uSnowN: { value: TEX.normalMap },
    uSnowR: { value: TEX.roughnessMap },
  };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);

    // ---------- vertex: раздуваем по нормали, несём мировые позицию и нормаль ----------
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vCapY;\nvarying vec3 vWp;\nvarying vec3 vWn;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vWn = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
        vCapY = vWn.y;
        // шапка тоньше к краю: на скатах слой сходит на нет, а не обрывается
        // стенкой — снег наметает горкой, самый толстый на макушке.
        // Нижняя граница раздува — НЕ ниже порога discard во фрагменте
        // (0.30–0.40): иначе на низкополигональных цилиндрах (поленья)
        // кромка шапки уже приподнята и висит плитой над поверхностью
        transformed += objectNormal * ${key} * smoothstep(0.42, 0.85, vCapY);
        vWp = (modelMatrix * vec4(transformed, 1.0)).xyz;`
      );

    // ---------- fragment ----------
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying float vCapY;
        varying vec3 vWp;
        varying vec3 vWn;
        uniform sampler2D uSnow;
        uniform sampler2D uSnowN;
        uniform sampler2D uSnowR;
        float hash21(vec2 p) {
          p = fract(p * vec2(123.34, 456.21));
          p += dot(p, p + 45.32);
          return fract(p.x * p.y);
        }`
      )
      .replace(
        '#include <map_fragment>',
        `// рваная кромка: снежная крупа осыпается по краю, а не режется по линии
        if (vCapY < 0.30 + hash21(floor(vWp.xz * 90.0)) * 0.10) discard;
        #include <map_fragment>
        // трипланар: вес проекций по мировой нормали, uv в масштабе террейна
        vec3 wn0 = normalize(vWn);
        vec3 bl = pow(abs(wn0), vec3(4.0));
        bl /= (bl.x + bl.y + bl.z);
        vec2 uvX = vWp.zy * ${SC};
        vec2 uvY = vWp.xz * ${SC};
        vec2 uvZ = vWp.xy * ${SC};
        vec3 snowTex = texture2D(uSnow, uvX).rgb * bl.x
                     + texture2D(uSnow, uvY).rgb * bl.y
                     + texture2D(uSnow, uvZ).rgb * bl.z;
        // тот же тинт и приглушение тёмных вмятин, что у террейна — вещество едино
        diffuseColor.rgb = mix(snowTex * vec3(0.85, 0.88, 0.96), vec3(0.86, 0.885, 0.955), 0.55);`
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float rough = texture2D(uSnowR, uvX).g * bl.x
                    + texture2D(uSnowR, uvY).g * bl.y
                    + texture2D(uSnowR, uvZ).g * bl.z;
        float roughnessFactor = roughness * rough;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `// трипланар normal-map (whiteout-смешение) — тот же рельеф, что на срезе
        vec3 nX = texture2D(uSnowN, uvX).xyz * 2.0 - 1.0;
        vec3 nY = texture2D(uSnowN, uvY).xyz * 2.0 - 1.0;
        vec3 nZ = texture2D(uSnowN, uvZ).xyz * 2.0 - 1.0;
        nX.xy *= 0.5; nY.xy *= 0.5; nZ.xy *= 0.5;
        nX = vec3(nX.xy + wn0.zy, abs(nX.z) * wn0.x);
        nY = vec3(nY.xy + wn0.xz, abs(nY.z) * wn0.y);
        nZ = vec3(nZ.xy + wn0.xy, abs(nZ.z) * wn0.z);
        vec3 wnorm = normalize(nX.zyx * bl.x + nY.xzy * bl.y + nZ.xyz * bl.z);
        normal = normalize((viewMatrix * vec4(wnorm, 0.0)).xyz);`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          // искры на снегу — мерцают при движении взгляда (как на земле)
          float camDist = length(cameraPosition - vWp);
          vec3 vdir = normalize(cameraPosition - vWp);
          vec2 cell = floor(vWp.xz * 26.0);
          float h1 = hash21(cell);
          float tw = fract(h1 * 93.7 + dot(vdir.xz, vec2(7.3, 11.1)) + vdir.y * 5.0);
          float sparkle = step(0.98, h1) * pow(smoothstep(0.72, 1.0, tw), 4.0);
          totalEmissiveRadiance += sparkle * exp(-camDist * 0.05) * 1.2;
        }`
      );
  };
  m.customProgramCacheKey = () => 'snowcap-' + key;
  MATS.set(key, m);
  return m;
}

// thickness — в ЛОКАЛЬНЫХ единицах меша: у масштабированных узлов (gltf)
// желаемые метры делят на mesh.getWorldScale().x (матрицы должны быть свежи)
export function snowCap(mesh, thickness) {
  const shell = new THREE.Mesh(mesh.geometry, capMaterial(thickness));
  shell.castShadow = false;
  shell.receiveShadow = true;
  mesh.add(shell);
  return shell;
}
