import { DiceContext } from "./contextAnalyzer";

export type StreakSnapshot = {
  noMoveStreak: number;
  repeatedValue: number | null;
  repeatCount: number;
};

export type DiceWeights = {
  weights: number[];
  normalized: number[];
};

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

export const buildDiceWeights = (context: DiceContext, streak: StreakSnapshot): DiceWeights => {
  const weights = Array.from({ length: 6 }, () => 1);

  // Anti-streak softening: reduce repeated last value slightly, never ban it.
  if (streak.repeatedValue !== null && streak.repeatCount >= 2) {
    const idx = streak.repeatedValue - 1;
    const factor = clamp(1 - (streak.repeatCount - 1) * 0.11, 0.45, 1);
    weights[idx] *= factor;
  }

  const playable = context.playableFaces;
  const kill = context.killFaces;
  const finish = context.finishFaces;
  const hasPlayable = playable.size > 0;

  for (let face = 1; face <= 6; face++) {
    const idx = face - 1;

    if (hasPlayable && playable.has(face)) weights[idx] *= 1.08;
    if (hasPlayable && !playable.has(face)) weights[idx] *= 0.9;
    if (kill.has(face)) weights[idx] *= 1.12;
    if (finish.has(face)) weights[idx] *= 1.1;
  }

  // No-dead-turn safety: if player is stuck, lightly boost playable outcomes.
  if (hasPlayable && streak.noMoveStreak >= 2) {
    const boost = clamp(1 + streak.noMoveStreak * 0.08, 1.08, 1.3);
    for (const face of playable) {
      weights[face - 1] *= boost;
    }
  }

  // Comeback balancing (subtle): small boost if significantly behind.
  if (hasPlayable && context.behindBySteps > 0) {
    const behindBoost = clamp(1 + context.behindBySteps / 220, 1, 1.12);
    for (const face of playable) {
      weights[face - 1] *= behindBoost;
    }
  }

  const total = weights.reduce((a, b) => a + b, 0);
  const normalized = weights.map((w) => w / total);

  return { weights, normalized };
};

