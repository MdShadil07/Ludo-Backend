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
    const totalControlledTokens = 4;
    const baseTokenCount = randomFloor(0, totalControlledTokens);
    const model = buildDiceWeights(
      {
        playableFaces: new Set([randomFloor(1, 6), randomFloor(1, 6)]),
        killFaces: new Set<number>(),
        revengeTargetKillFaces: new Set<number>(),
        leaderKillFaces: new Set<number>(),
        leaderPressureFaces: new Set<number>(),
        escapeFaces: new Set<number>(),
        finishFaces: new Set<number>(),
        behindBySteps: randomFloor(0, 40),
        totalControlledTokens,
        baseTokenCount,
        allInBase: baseTokenCount === totalControlledTokens,
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
