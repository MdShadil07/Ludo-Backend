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
  gameConfig: GameConfig,
  controllableColors?: PlayerColor[]
): { id: number; color: PlayerColor }[] {
  const result: { id: number; color: PlayerColor }[] = [];
  const controlledColors = Array.from(
    new Set((controllableColors && controllableColors.length ? controllableColors : [currentPlayerColor]))
  );
  const controlledSet = new Set(controlledColors);
  const teamBlockadeRulesEnabled = controlledSet.size > 1;
  const trackLength = TRACK_COORDS.length;
  const rotationThreshold = Math.max(1, trackLength - 2);

  const hasEnemyBlockadeAt = (position: number, alliedSet: Set<PlayerColor>) => {
    for (const enemyColor in tokens) {
      if (alliedSet.has(enemyColor as PlayerColor)) continue;
      const enemyTokens = tokens[enemyColor as PlayerColor] || [];
      const count = enemyTokens.filter((t) => {
        const inTrack = typeof t.position === "number" && t.position >= 0 && t.position < 52;
        const inPlay = t.status === "active" || t.status === "safe";
        return inTrack && inPlay && t.position === position;
      }).length;
      if (count >= 2) return true;
    }
    return false;
  };

  for (const color of controlledColors) {
    const playerTokens = tokens[color] || [];
    const homeCellCount = Math.max(1, gameConfig.HOME_RUNS[color].length - 1);
    const entryCoord = gameConfig.HOME_ENTRANCES[color];
    const entryIndex = TRACK_COORDS.findIndex(
      ([r, c]) => r === entryCoord[0] && c === entryCoord[1]
    );
    const entryIndexAdjusted =
      entryIndex === -1 ? -1 : (entryIndex - 2 + trackLength) % trackLength;

    for (const token of playerTokens) {
    if (token.status === "home") continue;

    const tokenOnTrack =
      typeof token.position === "number" &&
      token.position >= 0 &&
      token.position < 52 &&
      (token.status === "active" || token.status === "safe");
    const stackedCount = tokenOnTrack
      ? playerTokens.filter((t) => {
          const onTrack =
            typeof t.position === "number" &&
            t.position >= 0 &&
            t.position < 52 &&
            (t.status === "active" || t.status === "safe");
          return onTrack && t.position === token.position;
        }).length
      : 1;
    const forcedStackMove =
      tokenOnTrack && stackedCount >= 2 && !SAFE_INDICES.includes(token.position);
    if (forcedStackMove && diceValue % 2 !== 0) continue;
    const effectiveDice = forcedStackMove ? diceValue / 2 : diceValue;
    if (effectiveDice < 1) continue;

    // --- TOKEN IN BASE ---
    if (token.status === "base") {
      if (diceValue === 6) result.push({ id: token.id, color: token.color });
      continue;
    }

    const newSteps = token.steps + effectiveDice;

    if (token.position >= 52) {
      const currentHomeIndex = token.position - 52;
      if (currentHomeIndex + effectiveDice > homeCellCount) continue;
      result.push({ id: token.id, color: token.color });
      continue;
    }

    const movingStackCount = playerTokens.filter((t) => {
      const inTrack = typeof t.position === "number" && t.position >= 0 && t.position < 52;
      const inPlay = t.status === "active" || t.status === "safe";
      return inTrack && inPlay && t.position === token.position;
    }).length;
    const canBreakOrCrossBlockade = movingStackCount >= 2;

    const canContinueOnTrack = (() => {
      if (token.position >= 52) return false;
      for (let step = 1; step <= effectiveDice; step += 1) {
        const stepPos = (token.position + step) % trackLength;
        if (SAFE_INDICES.includes(stepPos)) continue;
        if (teamBlockadeRulesEnabled && hasEnemyBlockadeAt(stepPos, controlledSet) && !canBreakOrCrossBlockade) {
          return false;
        }
      }
      if (entryIndexAdjusted !== -1) {
        const distanceToArrow = (entryIndexAdjusted - token.position + trackLength) % trackLength;
        const completesLapAtArrow = token.steps + distanceToArrow >= rotationThreshold;
        if (completesLapAtArrow && effectiveDice > distanceToArrow) {
          const overshoot = effectiveDice - distanceToArrow;
          const canEnter = overshoot >= 1 && overshoot <= homeCellCount + 1;
          if (canEnter) return false;
        }
      }
      return true;
    })();

    const canEnterHome = (() => {
      if (token.position >= 52) return false;
      if (entryIndexAdjusted === -1) return false;
      const distanceToArrow = (entryIndexAdjusted - token.position + trackLength) % trackLength;
      const completesLapAtArrow = token.steps + distanceToArrow >= rotationThreshold;
      if (!completesLapAtArrow) return false;
      if (effectiveDice <= distanceToArrow) return false;
      for (let step = 1; step <= distanceToArrow; step += 1) {
        const stepPos = (token.position + step) % trackLength;
        if (SAFE_INDICES.includes(stepPos)) continue;
        if (teamBlockadeRulesEnabled && hasEnemyBlockadeAt(stepPos, controlledSet) && !canBreakOrCrossBlockade) {
          return false;
        }
      }
      const overshoot = effectiveDice - distanceToArrow;
      if (overshoot < 1) return false;
      if (overshoot > homeCellCount + 1) return false;
      return true;
    })();

    if (canContinueOnTrack || canEnterHome) {
      result.push({ id: token.id, color: token.color });
    }
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
  enterHome: boolean = true,
  alliedColors?: PlayerColor[]
): {
  updatedToken: Token;
  capturedToken?: { id: number; color: PlayerColor };
  capturedTokens?: { id: number; color: PlayerColor }[];
} {
  const updatedToken = { ...currentToken };
  let capturedToken: { id: number; color: PlayerColor } | undefined;
  let capturedTokens: { id: number; color: PlayerColor }[] | undefined;
  const alliedSet = new Set(
    Array.from(new Set((alliedColors && alliedColors.length ? alliedColors : [playerColor])))
  );
  const teamBlockadeRulesEnabled = alliedSet.size > 1;

  const trackLength = TRACK_COORDS.length;
  const homeCellCount = Math.max(1, gameConfig.HOME_RUNS[playerColor].length - 1);
  const player = gameConfig.players.find((p) => p.id === playerColor)!;
  const entryCoord = gameConfig.HOME_ENTRANCES[playerColor];
  const entryIndex = TRACK_COORDS.findIndex(
    ([r, c]) => r === entryCoord[0] && c === entryCoord[1]
  );
  const entryIndexAdjusted =
    entryIndex === -1 ? -1 : (entryIndex - 2 + trackLength) % trackLength;
  const rotationThreshold = Math.max(1, trackLength - 2);

  const movingStackCount = (allTokens[playerColor] || []).filter((t) => {
    const inTrack = typeof t.position === "number" && t.position >= 0 && t.position < 52;
    const inPlay = t.status === "active" || t.status === "safe";
    return inTrack && inPlay && t.position === currentToken.position;
  }).length;
  const canBreakOrCrossBlockade = movingStackCount >= 2;

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
    const completesLapAtArrow = updatedToken.steps + distanceToArrow >= rotationThreshold;
    if (completesLapAtArrow && diceValue > distanceToArrow) {
      const overshoot = diceValue - distanceToArrow;
      if (overshoot >= 1 && overshoot <= homeCellCount + 1) {
        if (overshoot === homeCellCount + 1) {
          updatedToken.status = "home";
          updatedToken.steps = updatedToken.steps + diceValue;
          updatedToken.position = 58;
          return { updatedToken };
        }
        updatedToken.status = "safe";
        updatedToken.steps = updatedToken.steps + diceValue;
        updatedToken.position = 52 + (overshoot - 1);
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
      if (alliedSet.has(enemyColor as PlayerColor)) continue;

      const enemies = allTokens[enemyColor as PlayerColor];

      const atPos = enemies.filter(
        (t) => t.position === newPos && (t.status === "active" || t.status === "safe")
      );

      if (atPos.length >= 2) {
        if (teamBlockadeRulesEnabled && !canBreakOrCrossBlockade) {
          return { updatedToken: currentToken };
        }
        if (teamBlockadeRulesEnabled && canBreakOrCrossBlockade) {
          capturedTokens = atPos.map((t) => ({ id: t.id, color: t.color }));
          capturedToken = capturedTokens[0];
          break;
        }
        // In non-team mode, keep previous behavior: stacked enemies on a cell are uncapturable.
        continue;
      }

      if (atPos.length === 1) {
        capturedToken = { id: atPos[0].id, color: atPos[0].color };
        capturedTokens = [capturedToken];
        break;
      }
    }
  }

  return { updatedToken, capturedToken, capturedTokens };
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
  roomPlayers: { _id: Types.ObjectId | string; color: PlayerColor }[],
  gameBoard: GameBoard,
  skipWinners: boolean = true
): number {
  const total = roomPlayers.length;

  for (let i = 1; i <= total; i++) {
    const next = (currentPlayerIndex + i) % total;
    if (!skipWinners) return next;

    const eliminated = gameBoard.winners.some(
      (w) => w.playerId.toString() === roomPlayers[next]._id.toString()
    );

    if (!eliminated) return next;
  }

  return currentPlayerIndex;
}
