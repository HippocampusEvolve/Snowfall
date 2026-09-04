import { bake, recipe } from 'world-core/materials';

// Процедурные карты не требуют DOM и считаются отдельно от главного потока.
self.onmessage = ({ data: names }) => {
  for (const name of names) {
    const source = recipe(name);
    const baked = bake(source.gen, source.size, source.normalStrength);
    const transfer = [baked.albedo.buffer, baked.normal.buffer, baked.rough.buffer];
    if (baked.metal) transfer.push(baked.metal.buffer);
    delete baked.height;
    self.postMessage({ name, baked }, transfer);
  }
};
