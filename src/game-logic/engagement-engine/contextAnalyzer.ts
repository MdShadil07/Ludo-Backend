import { GameConfig, PlayerColor, Token } from "../../config/ludoConfigBackend";
import { applyMove, findValidMoves } from "../../services/ludoGameLogicBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";

export type DiceContext = {
  playableFaces: Set<number>;
  killFaces: Set<number>;
  finishFaces: Set<number>;
  behindBySteps: number;
};

const sumSteps = (tokens: Token[]) => tokens.reduce((acc, t) => acc + Math.max(-1, t.steps), 0);

export const analyzeDiceContext = (
  state: RuntimeRoomState,
  playerColor: PlayerColor,
  gameConfig: GameConfig,
  controllableColors?: PlayerColor[]
): DiceContext => {
  const controlledColors = Array.from(
    new Set((controllableColors && controllableColors.length ? controllableColors : [playerColor]))
  );
  const playableFaces = new Set<number>();
  const killFaces = new Set<number>();
  const finishFaces = new Set<number>();
  const allTokens = state.gameBoard.tokens;
  const myTokens = controlledColors.flatMap((color) => allTokens[color] || []);

  for (let face = 1; face <= 6; face++) {
    const validMoves = findValidMoves(allTokens, playerColor, face, gameConfig, controlledColors);
    if (!validMoves.length) continue;

    playableFaces.add(face);

    for (const move of validMoves) {
      const token = (allTokens[move.color] || []).find((t) => t.id === move.id);
      if (!token) continue;

      const { updatedToken, capturedToken } = applyMove(
        token,
        face,
        move.color,
        gameConfig,
        allTokens,
        true,
        controlledColors
      );

      if (capturedToken) killFaces.add(face);
      if (token.status !== "home" && updatedToken.status === "home") finishFaces.add(face);
    }
  }

  const myScore = sumSteps(myTokens);
  let maxOther = myScore;
  for (const colorKey of Object.keys(allTokens) as PlayerColor[]) {
    if (controlledColors.includes(colorKey)) continue;
    const score = sumSteps(allTokens[colorKey] || []);
    if (score > maxOther) maxOther = score;
  }

  return {
    playableFaces,
    killFaces,
    finishFaces,
    behindBySteps: Math.max(0, maxOther - myScore),
  };
};
