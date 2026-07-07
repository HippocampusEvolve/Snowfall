// Снежный налёт на любом MeshStandardMaterial: подмешиваем белёсый цвет
// на гранях, смотрящих вверх. По умолчанию берём нормаль ПОСЛЕ normal map —
// снег ложится по рельефу (крап по иголкам, кромки брёвен). geoNormal: true —
// по геометрической нормали, сплошным одеялом (крыша под слоем снега).
export function snowTint(mat, tint, amount, threshold = 0.45, { geoNormal = false } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        vec3 snowRefN = normal;`
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
      {
        vec3 wN = inverseTransformDirection(${geoNormal ? 'snowRefN' : 'normal'}, viewMatrix);
        float snowAmt = smoothstep(${threshold.toFixed(2)}, 0.9, wN.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${tint}), snowAmt * ${amount.toFixed(2)});
        roughnessFactor = mix(roughnessFactor, 0.92, snowAmt * ${amount.toFixed(2)});
      }`
      );
  };
  mat.customProgramCacheKey = () => `snowtint-${tint}-${amount}-${threshold}-${geoNormal}`;
  return mat;
}
