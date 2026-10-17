import { generateGalaxy } from './galaxyModel.ts';

self.onmessage = (e: MessageEvent<{ count: number; seed: number }>) => {
  const g = generateGalaxy(e.data.count, e.data.seed);
  (self as unknown as Worker).postMessage(g, [g.positions.buffer, g.colors.buffer]);
};
