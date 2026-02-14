import crypto from "crypto";
import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { analyzeDiceContext, DiceContext } from "./contextAnalyzer";
import { getMomentumSnapshot, MomentumSnapshot } from "./momentumTracker";
import { buildProbabilityModel, ProbabilityModel } from "./probabilityController";
import { calculateRankContext, RankContext } from "./rankingCalculator";
import { DEFAULT_ENGAGEMENT_PROFILE, resolveEngagementTuning } from "./tuning";
import { engagementStateCache } from "./engagementStateCache";

export type DiceEngineInput = {
  roomId: string;
  playerId: string;
  playerColor: PlayerColor;
  controllableColors?: PlayerColor[];
  state: RuntimeRoomState;
  gameConfig: GameConfig;
  tuningProfile?: string;
};

export type DiceEngineDebug = {
  context: DiceContext;
  momentum: MomentumSnapshot;
  rank: RankContext;
  model: ProbabilityModel;
};

type GeneratedRollMeta = {
  allInBase: boolean;
  forced: boolean;
  generatedAt: number;
};

const generatedRollMeta = new Map<string, GeneratedRollMeta>();
const GENERATED_META_TTL_MS = 2 * 60 * 1000;

const keyOf = (roomId: string, playerId: string) => `${roomId}:${playerId}`;

const purgeGeneratedMeta = () => {
  const now = Date.now();
  for (const [key, meta] of generatedRollMeta.entries()) {
    if (now - meta.generatedAt > GENERATED_META_TTL_MS) {
      generatedRollMeta.delete(key);
    }
  }
};

const sampleByWeights = (normalizedWeights: number[]): number => {
  const r = crypto.randomInt(0, 1_000_000) / 1_000_000;
  let cumulative = 0;
  for (let i = 0; i < normalizedWeights.length; i += 1) {
    cumulative += normalizedWeights[i];
    if (r <= cumulative) return i + 1;
  }
  return 6;
};

export const generateEngagementDice = async (
  input: DiceEngineInput
): Promise<{ rolled: number; debug: DiceEngineDebug }> => {
  const { roomId, playerId, playerColor, controllableColors, state, gameConfig, tuningProfile } = input;
  purgeGeneratedMeta();
  const profileName = tuningProfile || DEFAULT_ENGAGEMENT_PROFILE;
  const tuning = resolveEngagementTuning(profileName);

  const context = analyzeDiceContext(state, playerColor, gameConfig, controllableColors);
  const momentum = await getMomentumSnapshot(roomId, playerId);
  const controlled = controllableColors && controllableColors.length ? controllableColors : [playerColor];
  const rank = calculateRankContext(state, gameConfig, controlled);
  const forceState = await engagementStateCache.getRoomForceState(roomId);
  const now = Date.now();
  const elapsedMs = Math.max(0, now - forceState.startedAt);
  const maxMs = Math.max(1, tuning.meta.maxMatchMinutes * 60 * 1000);
  const urgency = Math.max(0, Math.min(1, elapsedMs / maxMs));
  const activePlayerCount = Math.max(2, gameConfig.players.length);
  const canForceByGap = momentum.totalRolls - momentum.lastForcedRollAt >= tuning.forceLimiter.minTurnsBetweenForce;
  const dynamicBaseBudget = Math.max(tuning.forceLimiter.maxForcesPerMatch, activePlayerCount * 6);
  const budgetLimit =
    urgency >= 0.9
      ? dynamicBaseBudget + activePlayerCount
      : dynamicBaseBudget;
  const canForceByBudget = forceState.forcedCount < budgetLimit;
  const emergencyBaseLock = context.allInBase && momentum.turnsAllTokensInBase >= 2;
  const allowForce = canForceByGap && (canForceByBudget || emergencyBaseLock);

  const model = buildProbabilityModel(context, momentum, rank, { allowForce, tuning, urgency });
  const rolled = typeof model.forcedValue === "number" ? model.forcedValue : sampleByWeights(model.normalized);
  const forced = typeof model.forcedValue === "number";

  await engagementStateCache.setRoomForceState(roomId, {
    updatedAt: now,
    startedAt: forceState.startedAt || now,
    totalRolls: forceState.totalRolls + 1,
    forcedCount: forced ? forceState.forcedCount + 1 : forceState.forcedCount,
  });

  generatedRollMeta.set(keyOf(roomId, playerId), {
    allInBase: context.allInBase,
    forced,
    generatedAt: Date.now(),
  });

  return {
    rolled,
    debug: {
      context,
      momentum,
      rank,
      model,
    },
  };
};

export const consumeGeneratedRollMeta = (roomId: string, playerId: string): GeneratedRollMeta | undefined => {
  purgeGeneratedMeta();
  const key = keyOf(roomId, playerId);
  const meta = generatedRollMeta.get(key);
  if (!meta) return undefined;
  generatedRollMeta.delete(key);
  return meta;
};
