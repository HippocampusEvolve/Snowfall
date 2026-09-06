import { createRabbitBody } from './props/lab/rabbit.js';

self.onmessage = ({ data: { seed } }) => {
  try {
    const geometry = createRabbitBody(seed);
    const attributes = Object.fromEntries(Object.entries(geometry.attributes)
      .map(([name, attr]) => [name, { array: attr.array, itemSize: attr.itemSize }]));
    self.postMessage({ seed, attributes }, Object.values(attributes).map(a => a.array.buffer));
    geometry.dispose();
  } catch (error) {
    self.postMessage({ seed, error: error.message });
  }
};
