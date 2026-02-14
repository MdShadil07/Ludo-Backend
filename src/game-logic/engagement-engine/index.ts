import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { generateStrategicDice, pureRandomDice } from "./diceStrategy";
import { consumeGeneratedRollMeta } from "./diceEngineWrapper";
import { recordCaptureEvent, recordRollOutcome } from "./momentumTracker";
import { DEFAULT_ENGAGEMENT_PROFILE, resolveEngagementTuning } from "./tuning";

const ENABLE_ENGAGEMENT_DICE = process.env.ENGAGEMENT_DICE_ENABLED !== "false";
const ENGAGEMENT_DICE_DEBUG = process.env.ENGAGEMENT_DICE_DEBUG === "true";
const ENGAGEMENT_TELEMETRY = process.env.ENGAGEMENT_TELEMETRY === "true";

type GenerateInput = {
  roomId: string;
  playerId: string;
  playerColor: PlayerColor;
  controllableColors?: PlayerColor[];
  state: RuntimeRoomState;
  gameConfig: GameConfig;
  tuningProfile?: string;
};

export const generateDiceValue = async (input: GenerateInput): Promise<number> => {
  if (!ENABLE_ENGAGEMENT_DICE) return pureRandomDice();
  try {
    return await generateStrategicDice({
      ...input,
      debug: ENGAGEMENT_DICE_DEBUG,
    });
  } catch (error) {
    console.error("[engagement-dice] fallback to pure random due to error:", error);
    return pureRandomDice();
  }
};

export const reportDiceOutcome = async (
  roomId: string,
  playerId: string,
  rolledValue: number,
  hadValidMove: boolean,
  tuningProfile?: string
): Promise<void> => {
  const generatedMeta = consumeGeneratedRollMeta(roomId, playerId);
  const tuning = resolveEngagementTuning(tuningProfile);
  await recordRollOutcome(roomId, playerId, {
    rolledValue,
    hadValidMove,
    allInBase: generatedMeta?.allInBase ?? false,
    forced: generatedMeta?.forced ?? false,
    forgivenessRate: tuning.luck.forgivenessRate,
  });
  if (ENGAGEMENT_TELEMETRY) {
    console.log("[engagement-telemetry] roll", {
      roomId,
      playerId,
      rolledValue,
      hadValidMove,
      forced: generatedMeta?.forced ?? false,
      allInBase: generatedMeta?.allInBase ?? false,
      tuningProfile: tuningProfile || DEFAULT_ENGAGEMENT_PROFILE,
      ts: Date.now(),
    });
  }
};

export const reportCaptureOutcome = async (
  roomId: string,
  attackerPlayerId: string,
  victimPlayerIds: string[]
) : Promise<void> => {
  if (!victimPlayerIds.length) return;
  return recordCaptureEvent(roomId, attackerPlayerId, victimPlayerIds);
};
