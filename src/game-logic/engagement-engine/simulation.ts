import { buildDiceWeights } from "./probabilityModel";

const randomFloor = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

const sample = (probs: number[]) => {
  const r = Math.random();
  let c = 0;
  for (let i = 0; i < probs.length; i++) {
    c += probs[i];
    if (r <= c) return i + 1;
  }
  return 6;
};

export const runDiceSimulation = (iterations = 10000) => {
  const counts = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < iterations; i++) {
    const model = buildDiceWeights(
      {
        playableFaces: new Set([randomFloor(1, 6), randomFloor(1, 6)]),
        killFaces: new Set<number>(),
        finishFaces: new Set<number>(),
        behindBySteps: randomFloor(0, 40),
      },
      {
        noMoveStreak: randomFloor(0, 3),
        repeatedValue: randomFloor(1, 6),
        repeatCount: randomFloor(0, 3),
      }
    );
    const value = sample(model.normalized);
    counts[value - 1]++;
  }
  return counts;
};

