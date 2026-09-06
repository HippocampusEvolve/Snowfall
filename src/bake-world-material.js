import { bake, recipe } from 'world-core/materials';

// `rubble` in the library describes a WALL of stones and mortar. In Snowfall
// the same world name coats cave rock, loose stones and the fire ring, whose
// individual stones already have geometry. Use mineral surface recipes here,
// so no second, pillow-shaped masonry is painted inside every actual stone.
const MINERAL_SURFACES = Object.freeze({
  rubble: { recipe: 'surfaceRock', mean: 233.861084, tint: [81.10, 82.13, 79.12], contrast: 2.8, relief: 0.75 },
  rubbleWarm: { recipe: 'surfaceGravel', mean: 232.142670, tint: [98.45, 93.84, 85.62], contrast: 3, relief: 0.85 },
});
// Keep the established warm wood palette and real knots/grain. Only reduce
// stripe contrast; bark, end grain and fresh splits retain their identity.
const DRY_WOOD = Object.freeze({
  log: { mean: [68.07, 49.70, 33.33], contrast: 0.65 },
  beam: { mean: [124.71, 94.58, 62.12], contrast: 0.70 },
  floor: { mean: [72.57, 55.75, 39.12], contrast: 0.72 },
});

export function bakeWorldMaterial(name) {
  const mineral = MINERAL_SURFACES[name];
  const wood = DRY_WOOD[name];
  const source = recipe(mineral?.recipe || name);
  const generator = mineral || wood ? (x, y, size, pixel) => {
    source.gen(x, y, size, pixel);
    if (mineral) {
      const grain = (pixel.r - mineral.mean) * mineral.contrast;
      pixel.r = mineral.tint[0] + grain;
      pixel.g = mineral.tint[1] + grain;
      pixel.b = mineral.tint[2] + grain;
      pixel.rough = Math.max(0.90, pixel.rough);
    } else {
      pixel.r = wood.mean[0] + (pixel.r - wood.mean[0]) * wood.contrast;
      pixel.g = wood.mean[1] + (pixel.g - wood.mean[1]) * wood.contrast;
      pixel.b = wood.mean[2] + (pixel.b - wood.mean[2]) * wood.contrast;
      pixel.rough = Math.max(0.90, pixel.rough);
    }
  } : source.gen;
  const baked = bake(generator, source.size, mineral?.relief ?? source.normalStrength);
  if (name === 'surfaceSnow') {
    // Preserve the established world brightness, including caps and dug snow.
    const target = [0.381508, 0.379592, 0.390265];
    let mean = 0;
    const linear = v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    for (let i = 0; i < baked.albedo.length; i += 4) mean += linear(baked.albedo[i] / 255);
    mean /= baked.albedo.length / 4;
    for (let i = 0; i < baked.albedo.length; i += 4) for (let c = 0; c < 3; c++) {
      const value = linear(baked.albedo[i + c] / 255) * target[c] / mean;
      baked.albedo[i + c] = Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
    }
  }
  return baked;
}
