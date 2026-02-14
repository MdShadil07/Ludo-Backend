import crypto from "crypto";
import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { analyzeDiceContext, DiceContext } from "./contextAnalyzer";
import { getMomentumSnapshot, MomentumSnapshot } from "./momentumTracker";
import { buildProbabilityModel, ProbabilityModel } from "./probabilityController";
import { calculateRankContext, RankContext } from "./rankingCalculator";
import { StorySnapshot, updateStoryOnRoll } from "./storyDirector";
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
  story: StorySnapshot;
};

type GeneratedRollMeta = {
  allInBase: boolean;
  forced: boolean;
  generatedAt: number;
};

const generatedRollMeta = new Map<string, GeneratedRollMeta>();
const GENERATED_META_TTL_MS = 2 * 60 * 1000;
const ENABLE_PERCEPTION_MASKING = process.env.ENGAGEMENT_PERCEPTION_MASKING !== "false";

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

const randFloat = () => crypto.randomInt(0, 1_000_000) / 1_000_000;

const sampleWithoutSix = (normalizedWeights: number[]): number => {
  const nonSix = normalizedWeights.slice(0, 5);
  const total = nonSix.reduce((sum, value) => sum + Math.max(0, value), 0);
  if (total <= 0) return crypto.randomInt(1, 6);
  const normalized = nonSix.map((value) => Math.max(0, value) / total);
  return sampleByWeights([...normalized, 0]);
};

const applyPerceptionMasking = (probs: number[], momentum: MomentumSnapshot): number[] => {
  if (!ENABLE_PERCEPTION_MASKING) return probs;
  const uniform = 1 / probs.length;
  const blendAlpha = 0.06 + randFloat() * 0.08;
  let mixed = probs.map((p) => p * (1 - blendAlpha) + uniform * blendAlpha);

  // Avoid overly obvious deterministic peaks.
  const maxVal = Math.max(...mixed);
  const maxIdx = mixed.indexOf(maxVal);
  if (maxVal > 0.46) {
    const excess = maxVal - 0.46;
    mixed[maxIdx] = 0.46;
    const spread = excess / (mixed.length - 1);
    mixed = mixed.map((p, idx) => (idx === maxIdx ? p : p + spread));
  }

  // If users are seeing repeated outcomes, lightly diversify.
  if (momentum.repeatedValue !== null && momentum.repeatCount >= 2) {
    const idx = momentum.repeatedValue - 1;
    const shave = Math.min(0.08, 0.03 * momentum.repeatCount);
    const actual = Math.min(shave, mixed[idx] * 0.4);
    mixed[idx] -= actual;
    const share = actual / (mixed.length - 1);
    mixed = mixed.map((p, i) => (i === idx ? p : p + share));
  }

  // Micro jitter for natural-feeling variance.
  mixed = mixed.map((p) => Math.max(0.0001, p * (0.985 + randFloat() * 0.03)));
  const sum = mixed.reduce((a, b) => a + b, 0);
  return sum > 0 ? mixed.map((p) => p / sum) : probs;
};

export const generateEngagementDice = async (
  input: DiceEngineInput
): Promise<{ rolled: number; debug: DiceEngineDebug }> => {
  const { roomId, playerId, playerColor, controllableColors, state, gameConfig, tuningProfile } = input;
  purgeGeneratedMeta();
  const profileName = tuningProfile || DEFAULT_ENGAGEMENT_PROFILE;
  const tuning = resolveEngagementTuning(profileName);

  const momentum = await getMomentumSnapshot(roomId, playerId);
  const context = analyzeDiceContext(
    state,
    playerColor,
    gameConfig,
    controllableColors,
    momentum.revengeTargetColors
  );
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
  const story = await updateStoryOnRoll({
    roomId,
    roomPlayerId: playerId,
    rank,
    context,
  });

  const model = buildProbabilityModel(context, momentum, rank, {
    allowForce,
    tuning,
    urgency,
    storyPhase: story.phase,
  });
  const maskedNormalized = applyPerceptionMasking(model.normalized, momentum);
  let rolled = typeof model.forcedValue === "number" ? model.forcedValue : sampleByWeights(maskedNormalized);

  const consecutiveSixCount = momentum.repeatedValue === 6 ? momentum.repeatCount : 0;
  if (rolled === 6 && consecutiveSixCount >= 3) {
    rolled = sampleWithoutSix(maskedNormalized);
  } else if (rolled === 6 && consecutiveSixCount >= 2) {
    const baseRareChance = 0.1;
    const comebackBoost =
      (rank.behindGap > 0 ? 0.08 : 0) +
      (momentum.luckDelta < -2 ? 0.06 : 0) +
      (context.killFaces.has(6) || context.finishFaces.has(6) ? 0.05 : 0) +
      (context.allInBase ? 0.07 : 0);
    const rareThirdSixChance = Math.max(0.1, Math.min(0.35, baseRareChance + comebackBoost));
    const roll = randFloat();
    if (roll > rareThirdSixChance) {
      rolled = sampleWithoutSix(maskedNormalized);
    }
  }
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
      story,
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
