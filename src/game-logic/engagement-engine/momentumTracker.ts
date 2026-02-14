import { DEFAULT_ENGAGEMENT_TUNING } from "./tuning";
import { engagementStateCache } from "./engagementStateCache";
import { PlayerColor } from "../../config/ludoConfigBackend";

type PlayerMomentumState = {
  updatedAt: number;
  recentRolls: number[];
  noMoveStreak: number;
  turnsSinceSix: number;
  turnsAllTokensInBase: number;
  powerRollCharges: number;
  revengeArmedTurns: number;
  revengeTargetColors: PlayerColor[];
  luckDelta: number;
  totalRolls: number;
  lastForcedRollAt: number;
  recentlyKilledTurns: number;
  sessionAssistScore: number;
};

export type MomentumSnapshot = {
  recentRolls: number[];
  noMoveStreak: number;
  turnsSinceSix: number;
  turnsAllTokensInBase: number;
  powerRollCharges: number;
  revengeArmedTurns: number;
  revengeTargetColors: PlayerColor[];
  repeatedValue: number | null;
  repeatCount: number;
  recentLowRollPatternScore: number;
  luckDelta: number;
  totalRolls: number;
  lastForcedRollAt: number;
  recentlyKilledTurns: number;
  repeatedBandCount: number;
  sessionAssistScore: number;
};

export type RollOutcomeInput = {
  rolledValue: number;
  hadValidMove: boolean;
  allInBase: boolean;
  forced?: boolean;
  forgivenessRate?: number;
};

const MAX_RECENT_ROLLS = 10;
const createInitialState = (): PlayerMomentumState => ({
    updatedAt: Date.now(),
    recentRolls: [],
    noMoveStreak: 0,
    turnsSinceSix: 0,
    turnsAllTokensInBase: 0,
    powerRollCharges: 0,
    revengeArmedTurns: 0,
    revengeTargetColors: [],
    luckDelta: 0,
    totalRolls: 0,
    lastForcedRollAt: -999,
    recentlyKilledTurns: 0,
    sessionAssistScore: 0,
  });

const ensureState = async (roomId: string, playerId: string): Promise<PlayerMomentumState> => {
  const existing = await engagementStateCache.getMomentum(roomId, playerId);
  if (!existing) return createInitialState();
  return {
    updatedAt: Number(existing.updatedAt || Date.now()),
    recentRolls: Array.isArray(existing.recentRolls) ? existing.recentRolls : [],
    noMoveStreak: Number(existing.noMoveStreak || 0),
    turnsSinceSix: Number(existing.turnsSinceSix || 0),
    turnsAllTokensInBase: Number(existing.turnsAllTokensInBase || 0),
    powerRollCharges: Number(existing.powerRollCharges || 0),
    revengeArmedTurns: Number(existing.revengeArmedTurns || 0),
    revengeTargetColors: Array.isArray(existing.revengeTargetColors)
      ? (existing.revengeTargetColors as PlayerColor[])
      : [],
    luckDelta: Number(existing.luckDelta || 0),
    totalRolls: Number(existing.totalRolls || 0),
    lastForcedRollAt: Number(existing.lastForcedRollAt ?? -999),
    recentlyKilledTurns: Number(existing.recentlyKilledTurns || 0),
    sessionAssistScore: Number(existing.sessionAssistScore || 0),
  };
};

const computeRepeat = (recentRolls: number[]): { repeatedValue: number | null; repeatCount: number } => {
  if (!recentRolls.length) return { repeatedValue: null, repeatCount: 0 };
  const last = recentRolls[recentRolls.length - 1];
  let count = 0;
  for (let i = recentRolls.length - 1; i >= 0; i -= 1) {
    if (recentRolls[i] !== last) break;
    count += 1;
  }
  return { repeatedValue: last, repeatCount: count };
};

const computeLowRollPattern = (recentRolls: number[]): number => {
  if (!recentRolls.length) return 0;
  const window = recentRolls.slice(-5);
  const lowCount = window.filter((v) => v <= 2).length;
  return lowCount / window.length;
};

const computeRepeatedBandCount = (recentRolls: number[]): number => {
  if (!recentRolls.length) return 0;
  const bandOf = (v: number) => (v <= 2 ? "low" : v <= 4 ? "mid" : "high");
  const lastBand = bandOf(recentRolls[recentRolls.length - 1]);
  let count = 0;
  for (let i = recentRolls.length - 1; i >= 0; i -= 1) {
    if (bandOf(recentRolls[i]) !== lastBand) break;
    count += 1;
  }
  return count;
};

export const getMomentumSnapshot = async (roomId: string, playerId: string): Promise<MomentumSnapshot> => {
  const state = await ensureState(roomId, playerId);
  const repeat = computeRepeat(state.recentRolls);
  return {
    recentRolls: [...state.recentRolls],
    noMoveStreak: state.noMoveStreak,
    turnsSinceSix: state.turnsSinceSix,
    turnsAllTokensInBase: state.turnsAllTokensInBase,
    powerRollCharges: state.powerRollCharges,
    revengeArmedTurns: state.revengeArmedTurns,
    revengeTargetColors: [...state.revengeTargetColors],
    repeatedValue: repeat.repeatedValue,
    repeatCount: repeat.repeatCount,
    recentLowRollPatternScore: computeLowRollPattern(state.recentRolls),
    luckDelta: state.luckDelta,
    totalRolls: state.totalRolls,
    lastForcedRollAt: state.lastForcedRollAt,
    recentlyKilledTurns: state.recentlyKilledTurns,
    repeatedBandCount: computeRepeatedBandCount(state.recentRolls),
    sessionAssistScore: state.sessionAssistScore,
  };
};

export const recordRollOutcome = async (roomId: string, playerId: string, input: RollOutcomeInput) => {
  const state = await ensureState(roomId, playerId);
  state.recentRolls.push(input.rolledValue);
  if (state.recentRolls.length > MAX_RECENT_ROLLS) {
    state.recentRolls.splice(0, state.recentRolls.length - MAX_RECENT_ROLLS);
  }

  state.noMoveStreak = input.hadValidMove ? 0 : state.noMoveStreak + 1;
  state.turnsSinceSix = input.rolledValue === 6 ? 0 : state.turnsSinceSix + 1;
  state.totalRolls += 1;
  const forgivenessRate = Number.isFinite(input.forgivenessRate)
    ? Math.max(0.6, Math.min(0.99, Number(input.forgivenessRate)))
    : 0.9;
  const rawDelta = input.rolledValue - 3.5;
  state.luckDelta = state.luckDelta * forgivenessRate + rawDelta;
  if (input.forced) {
    state.lastForcedRollAt = state.totalRolls;
  }
  state.turnsAllTokensInBase =
    input.allInBase && input.rolledValue !== 6 ? state.turnsAllTokensInBase + 1 : 0;
  state.revengeArmedTurns = Math.max(0, state.revengeArmedTurns - 1);
  if (state.revengeArmedTurns === 0) {
    state.revengeTargetColors = [];
  }
  state.recentlyKilledTurns = Math.max(0, state.recentlyKilledTurns - 1);
  const sessionPressureDelta =
    (state.noMoveStreak >= 2 ? 0.7 : 0) +
    (state.recentlyKilledTurns > 0 ? 0.6 : 0) +
    (state.luckDelta < -2 ? 0.5 : 0);
  state.sessionAssistScore = Math.max(0, Math.min(8, state.sessionAssistScore * 0.9 + sessionPressureDelta));

  if (state.powerRollCharges > 0) {
    state.powerRollCharges -= 1;
  }

  state.updatedAt = Date.now();
  await engagementStateCache.setMomentum(roomId, playerId, state);
};

export const recordCaptureEvent = async (
  roomId: string,
  attackerPlayerId: string,
  attackerColor: PlayerColor,
  victims: Array<{ playerId: string; color: PlayerColor }>
) => {
  const attacker = await ensureState(roomId, attackerPlayerId);
  attacker.powerRollCharges = Math.min(
    DEFAULT_ENGAGEMENT_TUNING.powerRoll.maxCharges,
    attacker.powerRollCharges + 1
  );
  attacker.updatedAt = Date.now();
  await engagementStateCache.setMomentum(roomId, attackerPlayerId, attacker);

  for (const victimInfo of victims) {
    const victim = await ensureState(roomId, victimInfo.playerId);
    victim.revengeArmedTurns = Math.max(
      victim.revengeArmedTurns,
      DEFAULT_ENGAGEMENT_TUNING.drama.revengeWindowTurns
    );
    victim.revengeTargetColors = Array.from(
      new Set([...victim.revengeTargetColors, attackerColor])
    );
    victim.recentlyKilledTurns = Math.max(
      victim.recentlyKilledTurns,
      DEFAULT_ENGAGEMENT_TUNING.tiltProtection.recentDeathTurns
    );
    victim.updatedAt = Date.now();
    await engagementStateCache.setMomentum(roomId, victimInfo.playerId, victim);
  }
};
