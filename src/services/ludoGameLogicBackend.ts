import { Types } from "mongoose";
import {
  PlayerColor,
  Token,
  GameConfig,
  TRACK_COORDS,
  SAFE_INDICES,
} from "../config/ludoConfigBackend";
import { GameBoard } from "../models/Room";

/**
 * Find all tokens that can move
 */
export function findValidMoves(
  tokens: Record<PlayerColor, Token[]>,
  currentPlayerColor: PlayerColor,
  diceValue: number,
  gameConfig: GameConfig
): { id: number; color: PlayerColor }[] {
  const result: { id: number; color: PlayerColor }[] = [];

  const playerTokens = tokens[currentPlayerColor];
  const player = gameConfig.players.find((p) => p.id === currentPlayerColor);
  if (!player) return [];

  const trackLength = TRACK_COORDS.length;
  const homeCellCount = Math.max(1, gameConfig.HOME_RUNS[currentPlayerColor].length - 1);
  const entryCoord = gameConfig.HOME_ENTRANCES[currentPlayerColor];
  const entryIndex = TRACK_COORDS.findIndex(
    ([r, c]) => r === entryCoord[0] && c === entryCoord[1]
  );
  const entryIndexAdjusted =
    entryIndex === -1 ? -1 : (entryIndex - 2 + trackLength) % trackLength;
  const homeStartIndex =
    entryIndexAdjusted === -1 ? -1 : (entryIndexAdjusted + 1) % trackLength;

  for (const token of playerTokens) {
    if (token.status === "home") continue;

    // --- TOKEN IN BASE ---
    if (token.status === "base") {
      if (diceValue === 6) result.push({ id: token.id, color: token.color });
      continue;
    }

    const newSteps = token.steps + diceValue;

    if (token.position >= 52) {
      const currentHomeIndex = token.position - 52;
      if (currentHomeIndex + diceValue > homeCellCount) continue;
      result.push({ id: token.id, color: token.color });
      continue;
    }

    const canContinueOnTrack = (() => {
      if (token.position >= 52) return false;
      const newPos = (token.position + diceValue) % trackLength;

      if (!SAFE_INDICES.includes(newPos)) {
        let blocked = false;

        for (const enemyColor in tokens) {
          if (enemyColor === currentPlayerColor) continue;

          const enemies = tokens[enemyColor as PlayerColor];
          const count = enemies.filter(
            (t) => t.position === newPos && t.status === "active"
          ).length;

          if (count >= 2) {
            blocked = true;
            break;
          }
        }

        if (blocked) return false;
      }
      if (entryIndexAdjusted !== -1) {
        const distanceToArrow = (entryIndexAdjusted - token.position + trackLength) % trackLength;
        if (diceValue > distanceToArrow) {
          const toEntry = diceValue - distanceToArrow;
          const remaining = toEntry - 1;
          const canEnter = remaining > 0 && remaining <= homeCellCount + 1;
          if (canEnter) return false;
        }
      }
      return true;
    })();

    const canEnterHome = (() => {
      if (token.position >= 52) return false;
      if (entryIndexAdjusted === -1) return false;
      const distanceToArrow = (entryIndexAdjusted - token.position + trackLength) % trackLength;
      if (diceValue <= distanceToArrow) return false;
      const toEntry = diceValue - distanceToArrow;
      const remaining = toEntry - 1;
      if (remaining <= 0) return false;
      if (remaining > homeCellCount + 1) return false;
      return true;
    })();

    if (canContinueOnTrack || canEnterHome) {
      result.push({ id: token.id, color: token.color });
    }
  }

  return result;
}

/**
 * Apply move to token
 */
export function applyMove(
  currentToken: Token,
  diceValue: number,
  playerColor: PlayerColor,
  gameConfig: GameConfig,
  allTokens: Record<PlayerColor, Token[]>,
  enterHome: boolean = true
): { updatedToken: Token; capturedToken?: { id: number; color: PlayerColor } } {
  const updatedToken = { ...currentToken };
  let capturedToken: { id: number; color: PlayerColor } | undefined;

  const trackLength = TRACK_COORDS.length;
  const homeCellCount = Math.max(1, gameConfig.HOME_RUNS[playerColor].length - 1);
  const player = gameConfig.players.find((p) => p.id === playerColor)!;
  const entryCoord = gameConfig.HOME_ENTRANCES[playerColor];
  const entryIndex = TRACK_COORDS.findIndex(
    ([r, c]) => r === entryCoord[0] && c === entryCoord[1]
  );
  const entryIndexAdjusted =
    entryIndex === -1 ? -1 : (entryIndex - 2 + trackLength) % trackLength;
  const homeStartIndex =
    entryIndexAdjusted === -1 ? -1 : (entryIndexAdjusted + 1) % trackLength;

  // --- OUT OF BASE ---
  if (updatedToken.status === "base") {
    updatedToken.status = "active";
    updatedToken.steps = 0;
    updatedToken.position = player.homeStart;
    return { updatedToken };
  }

  const newSteps = updatedToken.steps + diceValue;

  // --- ALREADY IN HOME RUN ---
  if (updatedToken.position >= 52) {
    const currentHomeIndex = updatedToken.position - 52;
    const nextHomeIndex = currentHomeIndex + diceValue;
    if (nextHomeIndex > homeCellCount) {
      return { updatedToken };
    }
    if (nextHomeIndex === homeCellCount) {
      updatedToken.status = "home";
      updatedToken.steps = updatedToken.steps + diceValue;
      updatedToken.position = 58;
      return { updatedToken };
    }
    updatedToken.status = "safe";
    updatedToken.steps = updatedToken.steps + diceValue;
    updatedToken.position = 52 + nextHomeIndex;
    return { updatedToken };
  }

  // --- OPTIONAL HOME ENTRY (crossing entry cell) ---
  if (enterHome && entryIndexAdjusted !== -1 && updatedToken.position < 52) {
    const distanceToArrow = (entryIndexAdjusted - updatedToken.position + trackLength) % trackLength;
    if (diceValue > distanceToArrow) {
      const toEntry = diceValue - distanceToArrow;
      const remaining = toEntry - 1;
      if (remaining > 0 && remaining <= homeCellCount + 1) {
        if (remaining === homeCellCount + 1) {
          updatedToken.status = "home";
          updatedToken.steps = updatedToken.steps + diceValue;
          updatedToken.position = 58;
          return { updatedToken };
        }
        updatedToken.status = "safe";
        updatedToken.steps = updatedToken.steps + diceValue;
        updatedToken.position = 52 + (remaining - 1);
        return { updatedToken };
      }
    }
  }

  // --- MAIN TRACK ---
  const newPos = (updatedToken.position + diceValue) % trackLength;

  updatedToken.steps = newSteps;
  updatedToken.position = newPos;
  updatedToken.status = SAFE_INDICES.includes(newPos) ? "safe" : "active";

  // --- CAPTURE ---
  if (!SAFE_INDICES.includes(newPos)) {
    for (const enemyColor in allTokens) {
      if (enemyColor === playerColor) continue;

      const enemies = allTokens[enemyColor as PlayerColor];

      const atPos = enemies.filter(
        (t) => t.position === newPos && t.status === "active"
      );

      if (atPos.length === 1) {
        capturedToken = { id: atPos[0].id, color: atPos[0].color };
        break;
      }
    }
  }

  return { updatedToken, capturedToken };
}

/**
 * Check win
 */
export function checkWinCondition(
  tokens: Record<PlayerColor, Token[]>,
  color: PlayerColor
) {
  return tokens[color].every((t) => t.status === "home");
}

/**
 * Turn rotation
 */
export function advanceTurn(
  currentPlayerIndex: number,
  roomPlayers: { _id: Types.ObjectId; color: PlayerColor }[],
  gameBoard: GameBoard
): number {
  const total = roomPlayers.length;

  for (let i = 1; i <= total; i++) {
    const next = (currentPlayerIndex + i) % total;

    const eliminated = gameBoard.winners.some(
      (w) => w.playerId.toString() === roomPlayers[next]._id.toString()
    );

    if (!eliminated) return next;
  }

  return currentPlayerIndex;
}
