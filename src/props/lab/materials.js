import * as THREE from 'three';

// Lab palette, restrained for moonlight and fire rather than a bright showroom.
export function createSurvivalMaterials() {
  const make = (name, color, roughness, metalness = 0) => {
    const material = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    material.name = name;
    return material;
  };
  const flame = new THREE.ShaderMaterial({
    name: 'flame', transparent: true, depthWrite: false, side: THREE.FrontSide,
    toneMapped: false, uniforms: { uTime: { value: 0 } },
    vertexShader: `
      uniform float uTime;
      varying float vHeight;
      varying vec3 vLocal;
      varying vec3 vNormal;
      varying vec3 vViewDirection;
      void main() {
        vHeight = smoothstep(1.5, 2.43, position.y);
        vLocal = position;
        vec3 p = position;
        // Keep the lab's closed flame loft, but at a carried flame's height.
        p.y = 1.5 + (p.y - 1.5) * 0.66;
        p.xz *= 0.82;
        float flicker = sin(uTime * 7.0 + position.y * 8.0) * vHeight;
        p += vec3(flicker * 0.055, flicker * 0.025, flicker * 0.035);
        vec4 viewPosition = modelViewMatrix * vec4(p, 1.0);
        vViewDirection = -viewPosition.xyz;
        vNormal = normalMatrix * normal;
        gl_Position = projectionMatrix * viewPosition;
      }`,
    fragmentShader: `
      uniform float uTime;
      varying float vHeight;
      varying vec3 vLocal;
      varying vec3 vNormal;
      varying vec3 vViewDirection;
      void main() {
        float facing = abs(dot(normalize(vNormal), normalize(vViewDirection)));
        float rim = smoothstep(0.02, 0.85, facing);
        float wisp = sin(vLocal.y * 22.0 - uTime * 7.0 + vLocal.x * 16.0)
          * sin(vLocal.z * 21.0 + vLocal.y * 11.0 - uTime * 4.0);
        float density = clamp(0.8 + wisp * 0.2, 0.0, 1.0);
        float core = pow(facing, 2.5) * (1.0 - smoothstep(0.05, 0.75, vHeight));
        float fade = 1.0 - smoothstep(0.57, 1.0, vHeight);
        float alpha = rim * density * fade * mix(0.58, 0.9, core);
        vec3 amber = vec3(0.99, 0.28, 0.035);
        vec3 hot = vec3(1.0, 0.81, 0.31);
        gl_FragColor = vec4(mix(amber, hot, core), alpha);
      }`,
  });
  return {
    wood: make('wood', 0x806046, 0.86), leather: make('leather', 0x503629, 0.94),
    iron: make('iron', 0x697479, 0.63, 0.12), edge: make('edge', 0xb1bdc0, 0.43, 0.2),
    brass: make('brass', 0x9f8556, 0.59, 0.14), enamel: make('enamel', 0x63766a, 0.54),
    cloth: make('cloth', 0x826e50, 1), coal: make('coal', 0x372c24, 1), flame,
  };
}

export function createRabbitMaterials() {
  return {
    fur: new THREE.MeshStandardMaterial({ color: 0xe5e5d9, vertexColors: true, roughness: 1 }),
    eye: new THREE.MeshStandardMaterial({ color: 0x1b211f, roughness: 0.26 }),
    nose: new THREE.MeshStandardMaterial({ color: 0x766056, roughness: 0.85 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xb8beac }),
  };
}
