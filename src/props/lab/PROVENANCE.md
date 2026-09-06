# Procedural laboratory models

Copied from our `find-the-end.fun/tools/procedural-lab/public/experiments/procedural-world/` laboratory on 2026-09-05:

- `survival-props.js`: original solid profiles, closed lofts, sharpened edges, leather and cloth wraps.
- `rabbit.js`: original SDF body, marching tetrahedra, vertex pigment, skeleton, ears, eyes and animation.
- `rabbit-behavior.js`: original deterministic fixed-step behavior and ballistic hops, adapted to safe terrain patches in Snowfall.
- `generators.js`: the laboratory's seeded random generator only.

`materials.js` adapts the laboratory palette and animated volumetric flame to Snowfall's Three.js r170 WebGL renderer. `tools.js` changes only scale, working-point coordinates and game-facing pose metadata. These are source-generated meshes. No GLB, comparison rabbit asset, runtime request to the private lab or renderer upgrade is used.
