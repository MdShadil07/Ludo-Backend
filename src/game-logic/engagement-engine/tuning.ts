export type EngagementProfileName =
  | "fast_game"
  | "competitive"
  | "casual"
  | "beginner_help"
  | "event_mode";

export type EngagementTuning = {
  meta: {
    targetMatchMinutes: number;
    desiredComebackRate: number;
    maxMatchMinutes: number;
  };
  phase: {
    earlyBoost: number;
    midBoost: number;
    lateBoost: number;
  };
  luck: {
    debtBoost: number;
    forgivenessRate: number;
  };
  forceLimiter: {
    minTurnsBetweenForce: number;
    maxForcesPerMatch: number;
  };
  tiltProtection: {
    recentDeathTurns: number;
    recoveryBoost: number;
  };
  volatility: {
    base: number;
    nearFinishMultiplier: number;
  };
  diversity: {
    repeatPenaltyScale: number;
  };
  progressiveSix: {
    mildAt: number;
    strongAt: number;
    forceAt: number;
    mildBoost: number;
    strongBoost: number;
  };
  participation: {
    assistAfterBaseTurns: number;
    assistSixBoost: number;
  };
  tactical: {
    playableBoost: number;
    nonPlayablePenalty: number;
    killBoost: number;
    finishBoost: number;
  };
  rubberBand: {
    behindBoostPerRatio: number;
    maxBoost: number;
  };
  leaderNerf: {
    leadThreshold: number;
    maxNerf: number;
  };
  endgame: {
    nearWinCells: number;
    highRollBoost: number;
  };
  antiFrustration: {
    lowRollPatternThreshold: number;
    lowRollPenalty: number;
    highRollBoost: number;
  };
  drama: {
    revengeWindowTurns: number;
    revengeKillBoost: number;
    closeChaseGap: number;
  };
  powerRoll: {
    perChargeBoost: number;
    maxCharges: number;
  };
  luckBalance: {
    threshold: number;
    unluckyPlayableBoost: number;
    luckyHighRollNerf: number;
  };
  entropyNoise: {
    min: number;
    max: number;
  };
  tempoDirector: {
    earlyPlayable: number;
    midPlayable: number;
    latePlayable: number;
    earlyHigh: number;
    midHigh: number;
    lateHigh: number;
  };
  spreadAwareness: {
    spreadThreshold: number;
    killBoostWhenSpread: number;
    movementBoostWhenStacked: number;
  };
  emotionRecovery: {
    boost: number;
  };
  forceControl: {
    maxForcePerGame: number;
    minGapBetweenForces: number;
  };
  varietyMemory: {
    repeatedBandPenalty: number;
  };
  clutchDrama: {
    nearFinishKillBoost: number;
    closeMatchVolatilityBoost: number;
  };
  sessionAssist: {
    maxBoost: number;
    perPointBoost: number;
  };
  entropyFloor: number;
};

const BASE_COMPETITIVE: EngagementTuning = {
  meta: {
    targetMatchMinutes: 20,
    desiredComebackRate: 0.34,
    maxMatchMinutes: 30,
  },
  phase: {
    earlyBoost: 1.02,
    midBoost: 1.1,
    lateBoost: 1.18,
  },
  luck: {
    debtBoost: 1.18,
    forgivenessRate: 0.9,
  },
  forceLimiter: {
    minTurnsBetweenForce: 3,
    maxForcesPerMatch: 12,
  },
  tiltProtection: {
    recentDeathTurns: 3,
    recoveryBoost: 1.12,
  },
  volatility: {
    base: 1.06,
    nearFinishMultiplier: 1.16,
  },
  diversity: {
    repeatPenaltyScale: 0.9,
  },
  progressiveSix: {
    mildAt: 2,
    strongAt: 3,
    forceAt: 4,
    mildBoost: 1.75,
    strongBoost: 2.7,
  },
  participation: {
    assistAfterBaseTurns: 2,
    assistSixBoost: 3.1,
  },
  tactical: {
    playableBoost: 1.3,
    nonPlayablePenalty: 0.74,
    killBoost: 1.24,
    finishBoost: 1.2,
  },
  rubberBand: {
    behindBoostPerRatio: 0.24,
    maxBoost: 1.28,
  },
  leaderNerf: {
    leadThreshold: 20,
    maxNerf: 0.14,
  },
  endgame: {
    nearWinCells: 10,
    highRollBoost: 1.18,
  },
  antiFrustration: {
    lowRollPatternThreshold: 0.5,
    lowRollPenalty: 0.82,
    highRollBoost: 1.18,
  },
  drama: {
    revengeWindowTurns: 2,
    revengeKillBoost: 1.16,
    closeChaseGap: 14,
  },
  powerRoll: {
    perChargeBoost: 1.12,
    maxCharges: 2,
  },
  luckBalance: {
    threshold: 4.5,
    unluckyPlayableBoost: 1.18,
    luckyHighRollNerf: 0.9,
  },
  entropyNoise: {
    min: 0.97,
    max: 1.03,
  },
  tempoDirector: {
    earlyPlayable: 1.04,
    midPlayable: 1.12,
    latePlayable: 1.2,
    earlyHigh: 1,
    midHigh: 1.08,
    lateHigh: 1.15,
  },
  spreadAwareness: {
    spreadThreshold: 14,
    killBoostWhenSpread: 1.14,
    movementBoostWhenStacked: 1.08,
  },
  emotionRecovery: {
    boost: 1.12,
  },
  forceControl: {
    maxForcePerGame: 4,
    minGapBetweenForces: 4,
  },
  varietyMemory: {
    repeatedBandPenalty: 0.9,
  },
  clutchDrama: {
    nearFinishKillBoost: 1.16,
    closeMatchVolatilityBoost: 1.1,
  },
  sessionAssist: {
    maxBoost: 1.1,
    perPointBoost: 0.025,
  },
  entropyFloor: 0.05,
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

const withOverrides = (overrides: DeepPartial<EngagementTuning>): EngagementTuning => ({
  ...BASE_COMPETITIVE,
  ...overrides,
  meta: { ...BASE_COMPETITIVE.meta, ...(overrides.meta || {}) },
  phase: { ...BASE_COMPETITIVE.phase, ...(overrides.phase || {}) },
  luck: { ...BASE_COMPETITIVE.luck, ...(overrides.luck || {}) },
  forceLimiter: { ...BASE_COMPETITIVE.forceLimiter, ...(overrides.forceLimiter || {}) },
  tiltProtection: { ...BASE_COMPETITIVE.tiltProtection, ...(overrides.tiltProtection || {}) },
  volatility: { ...BASE_COMPETITIVE.volatility, ...(overrides.volatility || {}) },
  diversity: { ...BASE_COMPETITIVE.diversity, ...(overrides.diversity || {}) },
  progressiveSix: { ...BASE_COMPETITIVE.progressiveSix, ...(overrides.progressiveSix || {}) },
  participation: { ...BASE_COMPETITIVE.participation, ...(overrides.participation || {}) },
  tactical: { ...BASE_COMPETITIVE.tactical, ...(overrides.tactical || {}) },
  rubberBand: { ...BASE_COMPETITIVE.rubberBand, ...(overrides.rubberBand || {}) },
  leaderNerf: { ...BASE_COMPETITIVE.leaderNerf, ...(overrides.leaderNerf || {}) },
  endgame: { ...BASE_COMPETITIVE.endgame, ...(overrides.endgame || {}) },
  antiFrustration: { ...BASE_COMPETITIVE.antiFrustration, ...(overrides.antiFrustration || {}) },
  drama: { ...BASE_COMPETITIVE.drama, ...(overrides.drama || {}) },
  powerRoll: { ...BASE_COMPETITIVE.powerRoll, ...(overrides.powerRoll || {}) },
  luckBalance: { ...BASE_COMPETITIVE.luckBalance, ...(overrides.luckBalance || {}) },
  entropyNoise: { ...BASE_COMPETITIVE.entropyNoise, ...(overrides.entropyNoise || {}) },
  tempoDirector: { ...BASE_COMPETITIVE.tempoDirector, ...(overrides.tempoDirector || {}) },
  spreadAwareness: { ...BASE_COMPETITIVE.spreadAwareness, ...(overrides.spreadAwareness || {}) },
  emotionRecovery: { ...BASE_COMPETITIVE.emotionRecovery, ...(overrides.emotionRecovery || {}) },
  forceControl: { ...BASE_COMPETITIVE.forceControl, ...(overrides.forceControl || {}) },
  varietyMemory: { ...BASE_COMPETITIVE.varietyMemory, ...(overrides.varietyMemory || {}) },
  clutchDrama: { ...BASE_COMPETITIVE.clutchDrama, ...(overrides.clutchDrama || {}) },
  sessionAssist: { ...BASE_COMPETITIVE.sessionAssist, ...(overrides.sessionAssist || {}) },
});

export const ENGAGEMENT_TUNING_PROFILES: Record<EngagementProfileName, EngagementTuning> = {
  competitive: BASE_COMPETITIVE,
  fast_game: withOverrides({
    meta: { targetMatchMinutes: 16, desiredComebackRate: 0.32 },
    phase: { earlyBoost: 1.06, midBoost: 1.18, lateBoost: 1.26 },
    participation: { assistAfterBaseTurns: 1, assistSixBoost: 3.4 },
    endgame: { highRollBoost: 1.24 },
    volatility: { base: 1.1, nearFinishMultiplier: 1.22 },
  }),
  casual: withOverrides({
    meta: { targetMatchMinutes: 24, desiredComebackRate: 0.28 },
    phase: { earlyBoost: 1.01, midBoost: 1.06, lateBoost: 1.12 },
    leaderNerf: { maxNerf: 0.1 },
    volatility: { base: 1.02, nearFinishMultiplier: 1.08 },
    entropyNoise: { min: 0.985, max: 1.015 },
  }),
  beginner_help: withOverrides({
    meta: { targetMatchMinutes: 18, desiredComebackRate: 0.42 },
    luck: { debtBoost: 1.24, forgivenessRate: 0.86 },
    progressiveSix: { mildAt: 2, strongAt: 3, forceAt: 3, mildBoost: 1.95, strongBoost: 2.9 },
    participation: { assistAfterBaseTurns: 1, assistSixBoost: 3.6 },
    forceLimiter: { minTurnsBetweenForce: 5, maxForcesPerMatch: 5 },
    sessionAssist: { maxBoost: 1.16, perPointBoost: 0.035 },
  }),
  event_mode: withOverrides({
    meta: { targetMatchMinutes: 17, desiredComebackRate: 0.37 },
    phase: { earlyBoost: 1.04, midBoost: 1.14, lateBoost: 1.28 },
    volatility: { base: 1.14, nearFinishMultiplier: 1.28 },
    clutchDrama: { nearFinishKillBoost: 1.22, closeMatchVolatilityBoost: 1.16 },
    entropyNoise: { min: 0.96, max: 1.04 },
  }),
};

export const DEFAULT_ENGAGEMENT_PROFILE: EngagementProfileName = "competitive";
export const DEFAULT_ENGAGEMENT_TUNING: EngagementTuning = BASE_COMPETITIVE;

export const resolveEngagementTuning = (profile?: string): EngagementTuning => {
  // Unified adaptive tuning for consistency across all rooms.
  // Keep profile argument for backward compatibility, but intentionally ignore it.
  void profile;
  return DEFAULT_ENGAGEMENT_TUNING;
};

export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
