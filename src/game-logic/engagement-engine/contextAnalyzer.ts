import { GameConfig, PlayerColor, SAFE_INDICES, Token } from "../../config/ludoConfigBackend";
import { applyMove, findValidMoves } from "../../services/ludoGameLogicBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";

export type DiceContext = {
  playableFaces: Set<number>;
  killFaces: Set<number>;
  revengeTargetKillFaces: Set<number>;
  leaderKillFaces: Set<number>;
  leaderPressureFaces: Set<number>;
  escapeFaces: Set<number>;
  finishFaces: Set<number>;
  behindBySteps: number;
  totalControlledTokens: number;
  baseTokenCount: number;
  allInBase: boolean;
};

const sumSteps = (tokens: Token[]) => tokens.reduce((acc, t) => acc + Math.max(-1, t.steps), 0);
const TRACK_LENGTH = 52;

const isTrackToken = (token: Token) =>
  (token.status === "active" || token.status === "safe") &&
  typeof token.position === "number" &&
  token.position >= 0 &&
  token.position < TRACK_LENGTH;

const forwardDistance = (from: number, to: number) => (to - from + TRACK_LENGTH) % TRACK_LENGTH;

const isThreatenedByEnemy = (
  position: number,
  allTokens: Record<PlayerColor, Token[]>,
  alliedSet: Set<PlayerColor>
) => {
  for (const colorKey of Object.keys(allTokens) as PlayerColor[]) {
    if (alliedSet.has(colorKey)) continue;
    for (const token of allTokens[colorKey] || []) {
      if (!isTrackToken(token)) continue;
      const dist = forwardDistance(token.position, position);
      if (dist >= 1 && dist <= 6) return true;
    }
  }
  return false;
};

const getLeaderEnemyColors = (
  allTokens: Record<PlayerColor, Token[]>,
  controlledColors: PlayerColor[]
) => {
  let maxScore = Number.NEGATIVE_INFINITY;
  const enemyScores: Array<{ color: PlayerColor; score: number }> = [];
  for (const colorKey of Object.keys(allTokens) as PlayerColor[]) {
    if (controlledColors.includes(colorKey)) continue;
    const score = sumSteps(allTokens[colorKey] || []);
    enemyScores.push({ color: colorKey, score });
    maxScore = Math.max(maxScore, score);
  }
  if (!Number.isFinite(maxScore)) return new Set<PlayerColor>();
  return new Set(enemyScores.filter((entry) => entry.score === maxScore).map((entry) => entry.color));
};

export const analyzeDiceContext = (
  state: RuntimeRoomState,
  playerColor: PlayerColor,
  gameConfig: GameConfig,
  controllableColors?: PlayerColor[],
  revengeTargetColors?: PlayerColor[]
): DiceContext => {
  const controlledColors = Array.from(
    new Set((controllableColors && controllableColors.length ? controllableColors : [playerColor]))
  );
  const controlledSet = new Set(controlledColors);
  const playableFaces = new Set<number>();
  const killFaces = new Set<number>();
  const revengeTargetKillFaces = new Set<number>();
  const leaderKillFaces = new Set<number>();
  const leaderPressureFaces = new Set<number>();
  const escapeFaces = new Set<number>();
  const finishFaces = new Set<number>();
  const allTokens = state.gameBoard.tokens;
  const leaderEnemyColors = getLeaderEnemyColors(allTokens, controlledColors);
  const myTokens = controlledColors.flatMap((color) => allTokens[color] || []);
  const totalControlledTokens = myTokens.length;
  const baseTokenCount = myTokens.filter((token) => token.status === "base").length;
  const allInBase = totalControlledTokens > 0 && baseTokenCount === totalControlledTokens;

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

      if (capturedToken) {
        killFaces.add(face);
        if (revengeTargetColors?.includes(capturedToken.color)) {
          revengeTargetKillFaces.add(face);
        }
        if (leaderEnemyColors.has(capturedToken.color)) {
          leaderKillFaces.add(face);
          leaderPressureFaces.add(face);
        }
      }

      const tokenWasThreatened = isTrackToken(token)
        ? isThreatenedByEnemy(token.position, allTokens, controlledSet)
        : false;
      const tokenIsNowSafe =
        updatedToken.status === "home" ||
        (isTrackToken(updatedToken) && !isThreatenedByEnemy(updatedToken.position, allTokens, controlledSet));
      if (tokenWasThreatened && tokenIsNowSafe) {
        escapeFaces.add(face);
      }

      if (isTrackToken(updatedToken)) {
        for (const enemyColor of leaderEnemyColors) {
          for (const enemyToken of allTokens[enemyColor] || []) {
            if (!isTrackToken(enemyToken)) continue;
            if (SAFE_INDICES.includes(enemyToken.position)) continue;
            const dist = forwardDistance(updatedToken.position, enemyToken.position);
            if (dist >= 1 && dist <= 6) {
              leaderPressureFaces.add(face);
              break;
            }
          }
          if (leaderPressureFaces.has(face)) break;
        }
      }

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
    revengeTargetKillFaces,
    leaderKillFaces,
    leaderPressureFaces,
    escapeFaces,
    finishFaces,
    behindBySteps: Math.max(0, maxOther - myScore),
    totalControlledTokens,
    baseTokenCount,
    allInBase,
  };
};
