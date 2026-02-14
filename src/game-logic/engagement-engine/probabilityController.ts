import { DiceContext } from "./contextAnalyzer";
import { StoryPhase } from "./engagementStateCache";
import { MomentumSnapshot } from "./momentumTracker";
import { RankContext } from "./rankingCalculator";
import { DEFAULT_ENGAGEMENT_TUNING, EngagementTuning, clamp } from "./tuning";

export type ProbabilityModel = {
  weights: number[];
  normalized: number[];
  forcedValue?: number;
};

type ProbabilityOptions = {
  allowForce?: boolean;
  tuning?: EngagementTuning;
  urgency?: number;
  storyPhase?: StoryPhase;
};

const normalizeWithEntropyFloor = (weights: number[], floor: number) => {
  const safeWeights = weights.map((w) => Math.max(0.0001, w));
  const total = safeWeights.reduce((a, b) => a + b, 0);
  const probs = safeWeights.map((w) => w / total).map((p) => Math.max(floor, p));
  const renorm = probs.reduce((a, b) => a + b, 0);
  return probs.map((p) => p / renorm);
};

const enforceMinProbability = (probs: number[], faceIndex: number, minValue: number): number[] => {
  const minProb = clamp(minValue, 0, 0.95);
  if (probs[faceIndex] >= minProb) return probs;
  const deficit = minProb - probs[faceIndex];
  let remaining = 1 - probs[faceIndex];
  if (remaining <= 0) return probs;
  const next = [...probs];
  for (let i = 0; i < next.length; i += 1) {
    if (i === faceIndex) continue;
    const share = next[i] / remaining;
    next[i] = Math.max(0, next[i] - deficit * share);
  }
  next[faceIndex] = minProb;
  const sum = next.reduce((a, b) => a + b, 0);
  return sum > 0 ? next.map((p) => p / sum) : probs;
};

export const buildProbabilityModel = (
  context: DiceContext,
  momentum: MomentumSnapshot,
  rank: RankContext,
  options?: ProbabilityOptions
): ProbabilityModel => {
  const tuning = options?.tuning || DEFAULT_ENGAGEMENT_TUNING;
  const weights = Array.from({ length: 6 }, () => 1);
  const playable = context.playableFaces;
  const hasPlayable = playable.size > 0;
  const allowForce = options?.allowForce !== false;
  const urgency = clamp(options?.urgency ?? 0, 0, 1);
  const storyPhase = options?.storyPhase || "start";
  const randNoise = () =>
    tuning.entropyNoise.min + Math.random() * (tuning.entropyNoise.max - tuning.entropyNoise.min);

  // 1) Progressive six with explicit hard pity.
  if (allowForce && momentum.turnsSinceSix >= tuning.progressiveSix.forceAt) {
    return { weights, normalized: [0, 0, 0, 0, 0, 1], forcedValue: 6 };
  }
  if (momentum.turnsSinceSix >= tuning.progressiveSix.strongAt) {
    weights[5] *= tuning.progressiveSix.strongBoost;
  } else if (momentum.turnsSinceSix >= tuning.progressiveSix.mildAt) {
    weights[5] *= tuning.progressiveSix.mildBoost;
  }

  // 2) Participation guarantee for base-locked players.
  if (context.allInBase && momentum.turnsAllTokensInBase >= tuning.participation.assistAfterBaseTurns) {
    weights[5] *= tuning.participation.assistSixBoost;
  }
  if (
    allowForce &&
    context.allInBase &&
    momentum.turnsAllTokensInBase >= tuning.participation.assistAfterBaseTurns + 2
  ) {
    // Hard rescue for stalled players to avoid long idle frustration.
    return { weights, normalized: [0, 0, 0, 0, 0, 1], forcedValue: 6 };
  }

  // If most tokens are still in base, bias spawn outcomes without fully removing uncertainty.
  if (context.totalControlledTokens > 0) {
    const baseRatio = context.baseTokenCount / context.totalControlledTokens;
    if (baseRatio >= 0.75) {
      weights[5] *= 1.45;
      weights[0] *= 0.86;
      weights[1] *= 0.88;
    }
  }

  // Expected value balancing across match history.
  if (momentum.luckDelta <= -tuning.luckBalance.threshold && hasPlayable) {
    for (const face of playable) {
      weights[face - 1] *= tuning.luckBalance.unluckyPlayableBoost * tuning.luck.debtBoost;
    }
  }
  if (momentum.luckDelta >= tuning.luckBalance.threshold) {
    weights[5] *= tuning.luckBalance.luckyHighRollNerf;
    weights[4] *= 1 - (1 - tuning.luckBalance.luckyHighRollNerf) * 0.7;
  }

  // Tempo director by match phase.
  const phasePlayableBoost =
    rank.matchPhase === "early"
      ? tuning.tempoDirector.earlyPlayable * tuning.phase.earlyBoost
      : rank.matchPhase === "mid"
        ? tuning.tempoDirector.midPlayable * tuning.phase.midBoost
        : tuning.tempoDirector.latePlayable * tuning.phase.lateBoost;
  const phaseHighBoost =
    rank.matchPhase === "early"
      ? tuning.tempoDirector.earlyHigh
      : rank.matchPhase === "mid"
        ? tuning.tempoDirector.midHigh
        : tuning.tempoDirector.lateHigh;
  if (hasPlayable) {
    for (const face of playable) {
      weights[face - 1] *= phasePlayableBoost;
    }
  }
  weights[4] *= phaseHighBoost;
  weights[5] *= phaseHighBoost;

  // Time-based acceleration as match approaches cap (30m target ceiling).
  if (urgency > 0) {
    const playableUrgencyBoost = 1 + urgency * 0.28;
    const highUrgencyBoost = 1 + urgency * 0.36;
    if (hasPlayable) {
      for (const face of playable) {
        weights[face - 1] *= playableUrgencyBoost;
      }
    }
    weights[4] *= highUrgencyBoost;
    weights[5] *= highUrgencyBoost;
    weights[0] *= 1 - urgency * 0.2;
    weights[1] *= 1 - urgency * 0.16;
  }

  // Tactical relevance.
  for (let face = 1; face <= 6; face += 1) {
    const idx = face - 1;
    if (hasPlayable && playable.has(face)) weights[idx] *= tuning.tactical.playableBoost;
    if (hasPlayable && !playable.has(face)) weights[idx] *= tuning.tactical.nonPlayablePenalty;
    if (context.killFaces.has(face)) weights[idx] *= tuning.tactical.killBoost;
    if (context.finishFaces.has(face)) weights[idx] *= tuning.tactical.finishBoost;
  }

  // Aggression tuning: when a kill is available, tilt slightly toward tactical capture.
  if (context.killFaces.size > 0) {
    const killPressure =
      (rank.behindGap > 0 ? 1.08 : 1) *
      (momentum.revengeArmedTurns > 0 ? 1.12 : 1) *
      (rank.anyPlayerNearWin ? 1.1 : 1);
    for (const face of context.killFaces) {
      weights[face - 1] *= killPressure;
    }
  }

  // Kill exchange memory: if A killed B recently, bias B toward threatening A soon.
  if (momentum.revengeArmedTurns > 0 && context.revengeTargetKillFaces.size > 0) {
    const revengeBoost = 1.18 + Math.min(0.18, momentum.revengeArmedTurns * 0.05);
    for (const face of context.revengeTargetKillFaces) {
      weights[face - 1] *= revengeBoost;
    }
  }

  // Outcome director: push pressure specifically toward current leaders, not random kills.
  if (context.leaderKillFaces.size > 0) {
    const leaderKillBoost =
      (rank.behindGap > 0 ? 1.28 : 1.14) *
      (rank.closeChase ? 1.08 : 1) *
      (momentum.revengeArmedTurns > 0 ? 1.06 : 1);
    for (const face of context.leaderKillFaces) {
      weights[face - 1] *= leaderKillBoost;
    }
  }
  if (context.leaderPressureFaces.size > 0) {
    const pressureBoost = rank.behindGap > 0 ? 1.14 : 1.06;
    for (const face of context.leaderPressureFaces) {
      weights[face - 1] *= pressureBoost;
    }
  }

  // Outcome director: make trailing/tilted players survive long enough to stay engaged.
  if (context.escapeFaces.size > 0) {
    const underPressure = rank.isLast || momentum.noMoveStreak >= 2 || momentum.recentlyKilledTurns > 0;
    const escapeBoost = underPressure ? 1.24 : 1.1;
    for (const face of context.escapeFaces) {
      weights[face - 1] *= escapeBoost;
    }
    if (underPressure && hasPlayable) {
      for (const face of playable) {
        if (context.escapeFaces.has(face)) continue;
        weights[face - 1] *= 0.96;
      }
    }
  }

  // 9) Anti Snowball Protection:
  // leaders should feel heat: less comfort, more exposure to chases/counters.
  if (rank.isLeader) {
    const pressureIntensity = clamp(rank.leadGap / 90, 0.05, 0.26);
    const comfortNerf = 1 - pressureIntensity;
    // Reduce "comfortable drift" outcomes for leader.
    weights[5] *= comfortNerf;
    weights[4] *= 1 - pressureIntensity * 0.72;
    weights[3] *= 1 - pressureIntensity * 0.35;
    // Push leader toward tactical conflict windows instead of cruising.
    if (context.leaderPressureFaces.size > 0) {
      for (const face of context.leaderPressureFaces) {
        weights[face - 1] *= 1.08 + pressureIntensity * 0.5;
      }
    }
    if (context.escapeFaces.size > 0) {
      // Leader gets less guaranteed safety.
      for (const face of context.escapeFaces) {
        weights[face - 1] *= 0.95;
      }
    }
  }

  // 10) Last Place Hope Engine:
  // always preserve believable comeback opportunities for retention.
  if (rank.isLast) {
    const hopeBoost = clamp(1.16 + rank.behindRatio * 0.22, 1.16, 1.34);
    if (hasPlayable) {
      for (const face of playable) {
        weights[face - 1] *= hopeBoost;
      }
    }
    for (const face of context.escapeFaces) {
      weights[face - 1] *= 1.2;
    }
    for (const face of context.leaderPressureFaces) {
      weights[face - 1] *= 1.16;
    }
    for (const face of context.leaderKillFaces) {
      weights[face - 1] *= 1.18;
    }
    // Reduce dead-end low rolls a bit when last place is under pressure.
    weights[0] *= 0.88;
    weights[1] *= 0.92;
  }

  // Global match story curve director.
  if (storyPhase === "spread") {
    weights[0] *= 0.95;
    weights[1] *= 0.98;
    if (hasPlayable) {
      for (const face of playable) weights[face - 1] *= 1.05;
    }
  } else if (storyPhase === "fights") {
    for (const face of context.killFaces) weights[face - 1] *= 1.14;
    for (const face of context.leaderPressureFaces) weights[face - 1] *= 1.1;
  } else if (storyPhase === "leader") {
    if (!rank.isLeader) {
      for (const face of context.leaderPressureFaces) weights[face - 1] *= 1.18;
    } else {
      for (const face of context.escapeFaces) weights[face - 1] *= 0.94;
    }
  } else if (storyPhase === "hope") {
    if (!rank.isLeader) {
      for (const face of context.escapeFaces) weights[face - 1] *= 1.14;
      for (const face of context.leaderKillFaces) weights[face - 1] *= 1.12;
    }
  } else if (storyPhase === "chaos") {
    for (const face of context.killFaces) weights[face - 1] *= 1.18;
    for (const face of context.escapeFaces) weights[face - 1] *= 1.09;
    weights[0] *= 1.05;
    weights[5] *= 1.08;
  } else if (storyPhase === "finish") {
    for (const face of context.finishFaces) weights[face - 1] *= 1.16;
    for (const face of context.killFaces) weights[face - 1] *= 1.12;
  }

  // Token spread awareness.
  if (rank.spreadHigh && context.killFaces.size > 0) {
    for (const face of context.killFaces) {
      weights[face - 1] *= tuning.spreadAwareness.killBoostWhenSpread;
    }
  } else if (!rank.spreadHigh && hasPlayable) {
    for (const face of playable) {
      weights[face - 1] *= tuning.spreadAwareness.movementBoostWhenStacked;
    }
  }

  // 3) Rubber band for players behind.
  if (hasPlayable && rank.behindGap > 0) {
    const dynamicCeiling = clamp(
      tuning.rubberBand.maxBoost - Math.max(0, rank.behindPlayerCount - 1) * 0.04,
      1.06,
      tuning.rubberBand.maxBoost
    );
    const boost = clamp(1 + rank.behindRatio * tuning.rubberBand.behindBoostPerRatio, 1, dynamicCeiling);
    for (const face of playable) {
      weights[face - 1] *= boost;
    }
  }

  // Dead-turn pressure relief: quickly pivot toward playable faces for inactive players.
  if (hasPlayable && momentum.noMoveStreak >= 2) {
    const streakBoost = clamp(1 + momentum.noMoveStreak * 0.16, 1.16, 1.9);
    for (const face of playable) {
      weights[face - 1] *= streakBoost;
    }
  }

  // Player emotion recovery after repeated setbacks.
  if (momentum.recentlyKilledTurns > 0 && hasPlayable) {
    for (const face of playable) {
      weights[face - 1] *= tuning.emotionRecovery.boost * tuning.tiltProtection.recoveryBoost;
    }
  }

  // Session-smart assist (retention): gentle boost if player session pressure is high.
  if (hasPlayable && momentum.sessionAssistScore > 0) {
    const sessionBoost = clamp(
      1 + momentum.sessionAssistScore * tuning.sessionAssist.perPointBoost,
      1,
      tuning.sessionAssist.maxBoost
    );
    for (const face of playable) {
      weights[face - 1] *= sessionBoost;
    }
  }

  // 4) Leader soft nerf.
  if (rank.isLeader && rank.leadGap >= tuning.leaderNerf.leadThreshold) {
    const nerf = clamp(rank.leadGap / 200, 0, tuning.leaderNerf.maxNerf);
    weights[5] *= 1 - nerf;
    weights[4] *= 1 - nerf * 0.65;
    if (context.finishFaces.size > 0) {
      for (const face of context.finishFaces) {
        // Keep clutch possible, but make runaway finishes less frequent.
        weights[face - 1] *= 0.9;
      }
    }
  }

  // 5) Kill reward: power roll charges from recent captures.
  if (momentum.powerRollCharges > 0) {
    const powerBoost = Math.pow(tuning.powerRoll.perChargeBoost, momentum.powerRollCharges);
    weights[3] *= powerBoost;
    weights[4] *= powerBoost;
    weights[5] *= powerBoost;
  }

  // 6) Endgame acceleration.
  if (rank.anyPlayerNearWin) {
    weights[3] *= 1 + (tuning.endgame.highRollBoost - 1) * 0.4;
    weights[4] *= 1 + (tuning.endgame.highRollBoost - 1) * 0.7;
    weights[5] *= tuning.endgame.highRollBoost;
    // If this player is already leading near finish, slightly increase tension.
    if (rank.isLeader) {
      weights[5] *= 0.92;
      weights[4] *= 0.95;
      weights[1] *= 1.05;
    }
    if (context.killFaces.size > 0) {
      for (const face of context.killFaces) {
        weights[face - 1] *= tuning.clutchDrama.nearFinishKillBoost;
      }
    }
  }

  // 7) Anti-frustration smoothing.
  if (momentum.recentLowRollPatternScore >= tuning.antiFrustration.lowRollPatternThreshold) {
    weights[0] *= tuning.antiFrustration.lowRollPenalty;
    weights[1] *= tuning.antiFrustration.lowRollPenalty;
    weights[2] *= 0.9;
    weights[3] *= tuning.antiFrustration.highRollBoost;
    weights[4] *= tuning.antiFrustration.highRollBoost;
    weights[5] *= 1.08;
  }
  if (momentum.repeatedValue !== null && momentum.repeatCount >= 2) {
    const idx = momentum.repeatedValue - 1;
    const repeatPenalty = clamp(1 - (momentum.repeatCount - 1) * 0.1, 0.55, 1);
    weights[idx] *= repeatPenalty;
  }
  if (momentum.repeatedBandCount >= 3) {
    const last = momentum.recentRolls[momentum.recentRolls.length - 1] ?? 0;
    const bandFaces = last <= 2 ? [1, 2] : last <= 4 ? [3, 4] : [5, 6];
    for (const face of bandFaces) {
      weights[face - 1] *= tuning.varietyMemory.repeatedBandPenalty * tuning.diversity.repeatPenaltyScale;
    }
  }

  // 8) Drama creation: revenge windows and close-chase tuning.
  if (momentum.revengeArmedTurns > 0 && context.killFaces.size > 0) {
    for (const face of context.killFaces) {
      weights[face - 1] *= tuning.drama.revengeKillBoost;
    }
  }
  if (rank.closeChase) {
    weights[2] *= 1.04;
    weights[3] *= 1.06;
    weights[4] *= 1.08;
    weights[0] *= 1 + (tuning.clutchDrama.closeMatchVolatilityBoost - 1) * 0.3;
    weights[5] *= tuning.clutchDrama.closeMatchVolatilityBoost;
  }

  // Base volatility slider: increase extreme swings slightly.
  if (tuning.volatility.base > 1) {
    weights[0] *= 1 + (tuning.volatility.base - 1) * 0.6;
    weights[5] *= tuning.volatility.base;
  }
  if (rank.anyPlayerNearWin && tuning.volatility.nearFinishMultiplier > 1) {
    weights[0] *= 1 + (tuning.volatility.nearFinishMultiplier - 1) * 0.6;
    weights[5] *= tuning.volatility.nearFinishMultiplier;
  }

  // Hard late-match rescue: prevent drag beyond expected cap without obvious forcing.
  if (urgency >= 0.98) {
    weights[0] *= 0.45;
    weights[1] *= 0.6;
    weights[2] *= 0.78;
    weights[3] *= 1.08;
    weights[4] *= 1.18;
    weights[5] *= 1.26;
  }

  // Micro entropy to avoid visible deterministic patterns.
  for (let i = 0; i < weights.length; i += 1) {
    weights[i] *= randNoise();
  }

  let normalized = normalizeWithEntropyFloor(weights, tuning.entropyFloor);

  // Consistency guard: keep six frequency high enough to avoid base-lock boredom.
  const baseRatio =
    context.totalControlledTokens > 0 ? context.baseTokenCount / context.totalControlledTokens : 0;
  let minSixProbability = 0.1;
  if (context.allInBase) minSixProbability = 0.34;
  else if (baseRatio >= 0.75) minSixProbability = 0.24;
  else if (baseRatio >= 0.5) minSixProbability = 0.18;
  if (momentum.noMoveStreak >= 2) {
    minSixProbability = Math.max(minSixProbability, 0.2);
  }
  if (urgency >= 0.9) {
    minSixProbability = Math.max(minSixProbability, 0.16);
  }
  if (rank.isLeader && rank.selfNearWin) {
    minSixProbability *= 0.9;
  }
  normalized = enforceMinProbability(normalized, 5, minSixProbability);

  return { weights, normalized };
};
