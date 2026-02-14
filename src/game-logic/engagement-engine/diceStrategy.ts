import crypto from "crypto";
import { GameConfig, PlayerColor } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { generateEngagementDice } from "./diceEngineWrapper";

export type DiceGenerationInput = {
  roomId: string;
  playerId: string;
  playerColor: PlayerColor;
  controllableColors?: PlayerColor[];
  state: RuntimeRoomState;
  gameConfig: GameConfig;
  tuningProfile?: string;
  debug?: boolean;
};

export const pureRandomDice = (): number => crypto.randomInt(1, 7);

export const generateStrategicDice = async (input: DiceGenerationInput): Promise<number> => {
  const { roomId, playerId, debug } = input;
  const { rolled, debug: debugState } = await generateEngagementDice(input);

  if (debug) {
    console.log("[engagement-dice] room", roomId, "player", playerId, {
      momentum: {
        noMoveStreak: debugState.momentum.noMoveStreak,
        turnsSinceSix: debugState.momentum.turnsSinceSix,
        turnsAllTokensInBase: debugState.momentum.turnsAllTokensInBase,
        powerRollCharges: debugState.momentum.powerRollCharges,
        revengeArmedTurns: debugState.momentum.revengeArmedTurns,
        repeatedValue: debugState.momentum.repeatedValue,
        repeatCount: debugState.momentum.repeatCount,
      },
      playableFaces: Array.from(debugState.context.playableFaces),
      killFaces: Array.from(debugState.context.killFaces),
      finishFaces: Array.from(debugState.context.finishFaces),
      behindBySteps: debugState.context.behindBySteps,
      baseTokenCount: debugState.context.baseTokenCount,
      totalControlledTokens: debugState.context.totalControlledTokens,
      allInBase: debugState.context.allInBase,
      rank: debugState.rank,
      weights: debugState.model.weights.map((w) => Number(w.toFixed(4))),
      rolled,
    });
  }

  return rolled;
};
