import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { generateStrategicDice, pureRandomDice } from "./diceStrategy";
import { recordRollOutcome } from "./streakController";

const ENABLE_ENGAGEMENT_DICE = process.env.ENGAGEMENT_DICE_ENABLED === "true";
const ENGAGEMENT_DICE_DEBUG = process.env.ENGAGEMENT_DICE_DEBUG === "true";

type GenerateInput = {
  roomId: string;
  playerId: string;
  playerColor: PlayerColor;
  controllableColors?: PlayerColor[];
  state: RuntimeRoomState;
  gameConfig: GameConfig;
};

export const generateDiceValue = (input: GenerateInput): number => {
  if (!ENABLE_ENGAGEMENT_DICE) return pureRandomDice();
  try {
    return generateStrategicDice({
      ...input,
      debug: ENGAGEMENT_DICE_DEBUG,
    });
  } catch (error) {
    console.error("[engagement-dice] fallback to pure random due to error:", error);
    return pureRandomDice();
  }
};

export const reportDiceOutcome = (
  roomId: string,
  playerId: string,
  rolledValue: number,
  hadValidMove: boolean
) => {
  recordRollOutcome(roomId, playerId, rolledValue, hadValidMove);
};
