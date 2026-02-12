import crypto from "crypto";
import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { analyzeDiceContext } from "./contextAnalyzer";
import { buildDiceWeights } from "./probabilityModel";
import { getStreakSnapshot } from "./streakController";

export type DiceGenerationInput = {
  roomId: string;
  playerId: string;
  playerColor: PlayerColor;
  controllableColors?: PlayerColor[];
  state: RuntimeRoomState;
  gameConfig: GameConfig;
  debug?: boolean;
};

export const pureRandomDice = (): number => crypto.randomInt(1, 7);

const sampleByWeights = (normalizedWeights: number[]): number => {
  const r = crypto.randomInt(0, 1_000_000) / 1_000_000;
  let cumulative = 0;
  for (let i = 0; i < normalizedWeights.length; i++) {
    cumulative += normalizedWeights[i];
    if (r <= cumulative) return i + 1;
  }
  return 6;
};

export const generateStrategicDice = (input: DiceGenerationInput): number => {
  const { roomId, playerId, playerColor, controllableColors, state, gameConfig, debug } = input;
  const streak = getStreakSnapshot(roomId, playerId);
  const context = analyzeDiceContext(state, playerColor, gameConfig, controllableColors);
  const model = buildDiceWeights(context, streak);
  const rolled = sampleByWeights(model.normalized);

  if (debug) {
    console.log("[engagement-dice] room", roomId, "player", playerId, {
      streak,
      playableFaces: Array.from(context.playableFaces),
      killFaces: Array.from(context.killFaces),
      finishFaces: Array.from(context.finishFaces),
      behindBySteps: context.behindBySteps,
      weights: model.weights.map((w) => Number(w.toFixed(4))),
      rolled,
    });
  }

  return rolled;
};
