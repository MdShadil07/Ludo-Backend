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

    if (hasPlayable && playable.has(face)) weights[idx] *= 1.22;
    if (hasPlayable && !playable.has(face)) weights[idx] *= 0.78;
    if (kill.has(face)) weights[idx] *= 1.25;
    if (finish.has(face)) weights[idx] *= 1.22;
  }

  // No-dead-turn safety: if player is stuck, boost playable outcomes.
  if (hasPlayable && streak.noMoveStreak >= 2) {
    const boost = clamp(1 + streak.noMoveStreak * 0.12, 1.15, 1.75);
    for (const face of playable) {
      weights[face - 1] *= boost;
    }
  }

  // Base-break balancing: heavily reduce "all tokens stuck in base" frustration.
  if (context.allInBase) {
    const boostSix = clamp(1.9 + streak.noMoveStreak * 0.35, 2, 4.2);
    weights[5] *= boostSix;
    weights[0] *= 0.82;
    weights[1] *= 0.88;
  } else if (context.baseTokenCount > 0 && context.totalControlledTokens > 0) {
    const baseRatio = context.baseTokenCount / context.totalControlledTokens;
    const boostSix = clamp(1 + baseRatio * 0.55 + streak.noMoveStreak * 0.06, 1.05, 1.55);
    weights[5] *= boostSix;
  }

  // Tempo bias: when no tactical opportunities are present, lean toward faster board progression.
  if (hasPlayable && kill.size === 0 && finish.size === 0) {
    for (const face of playable) {
      if (face >= 4) weights[face - 1] *= 1.1;
      else if (face <= 2) weights[face - 1] *= 0.94;
    }
  }

  // Comeback balancing: moderate boost if significantly behind.
  if (hasPlayable && context.behindBySteps > 0) {
    const behindBoost = clamp(1 + context.behindBySteps / 160, 1, 1.22);
    for (const face of playable) {
      weights[face - 1] *= behindBoost;
    }
  }

  const total = weights.reduce((a, b) => a + b, 0);
  const normalized = weights.map((w) => w / total);

  return { weights, normalized };
};
