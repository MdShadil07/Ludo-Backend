import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { PlayerColor, Token, PLAYER_COLOR_MAPS, ALL_PLAYER_COLORS, getGameConfig } from "../config/ludoConfigBackend";
import { findValidMoves, applyMove, checkWinCondition, advanceTurn as advanceGameTurn } from "../services/ludoGameLogicBackend";
import { generateRoomCode, formatErrorResponse, formatSuccessResponse } from "../utils/helpers";
import { emitRoomUpdate } from "../socket";
import { gameStateCache } from "../state/gameStateCache";
import { invalidateRoomPlayers } from "../state/roomPlayersCache";
import { generateDiceValue, reportDiceOutcome } from "../game-logic/engagement-engine";

const PERF_DEBUG = process.env.GAME_PERF_DEBUG === "true";
const perfNow = () => Date.now();
const logPerf = (label: string, start: number, extra?: Record<string, unknown>) => {
  if (!PERF_DEBUG) return;
  const tookMs = perfNow() - start;
  console.log(`[perf] ${label} tookMs=${tookMs}`, extra || {});
};

// Helper to get Mongoose models safely
const Room = () => mongoose.model('Room');
const RoomPlayer = () => mongoose.model('RoomPlayer');
const User = () => mongoose.model('User');
const isValidObjectId = (id: unknown): id is string =>
  typeof id === "string" && Types.ObjectId.isValid(id);

const getColorOrder = (maxPlayers: number) =>
  PLAYER_COLOR_MAPS[maxPlayers] || PLAYER_COLOR_MAPS[4];

const sortPlayersByColor = (players: any[], maxPlayers: number) => {
  const order = getColorOrder(maxPlayers);
  const orderIndex = new Map(order.map((c, i) => [c, i]));
  return [...players].sort((a, b) => {
    const aIdx = orderIndex.get(a.color as PlayerColor) ?? 999;
    const bIdx = orderIndex.get(b.color as PlayerColor) ?? 999;
    return aIdx - bIdx;
  });
};

const getCurrentIndex = (room: any, orderedPlayers: any[]) => {
  const currentId = room?.gameBoard?.currentPlayerId?.toString();
  if (currentId) {
    const idx = orderedPlayers.findIndex(p => p._id.toString() === currentId);
    if (idx !== -1) return idx;
  }
  const fallback = room?.currentPlayerIndex ?? 0;
  return Math.min(Math.max(fallback, 0), Math.max(orderedPlayers.length - 1, 0));
};

const getTeammateColor = (maxPlayers: number, color: PlayerColor): PlayerColor | null => {
  const order = getColorOrder(maxPlayers);
  if (order.length < 4 || order.length % 2 !== 0) return null;
  const idx = order.indexOf(color);
  if (idx === -1) return null;
  const partnerIdx = (idx + order.length / 2) % order.length;
  return order[partnerIdx] || null;
};

const getControllableColors = (
  mode: "individual" | "team",
  maxPlayers: number,
  color: PlayerColor
): PlayerColor[] => {
  if (mode !== "team") return [color];
  const teammate = getTeammateColor(maxPlayers, color);
  if (!teammate || teammate === color) return [color];
  return [color, teammate];
};

/* ============================================================
   ROOM LIFECYCLE
============================================================ */
export async function createRoom(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const { maxPlayers = 4, mode = "individual", visibility = "public", selectedColor } = req.body;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6) {
      return res.status(400).json(formatErrorResponse("maxPlayers must be between 2 and 6"));
    }
    if (mode !== "individual" && mode !== "team") {
      return res.status(400).json(formatErrorResponse("Invalid mode"));
    }
    if (mode === "team" && (maxPlayers < 4 || maxPlayers % 2 !== 0)) {
      return res.status(400).json(formatErrorResponse("Team mode requires 4 or 6 players"));
    }
    const code = generateRoomCode();

    const room = await Room().create({
      code,
      hostId: userId,
      settings: { maxPlayers, mode, visibility },
      gameBoard: {
        tokens: {},
        currentPlayerId: null,
        diceValue: null,
        validMoves: [],
        gameLog: [],
        winners: [],
        lastRollAt: null,
      },
    });

    const colors = PLAYER_COLOR_MAPS[maxPlayers] || PLAYER_COLOR_MAPS[4];
    const hostColor = selectedColor && colors.includes(selectedColor) ? selectedColor : colors[0];

    const rp = await RoomPlayer().create({
      roomId: room._id,
      userId,
      color: hostColor,
    });

    room.players.push(rp._id);
    await room.save();

    return res.json(
      formatSuccessResponse(
        {
          ...room.toObject(),
          id: room._id,
        },
        "Room created"
      )
    );
  } catch (e) {
    console.error("Create room error:", e);
    return res.status(500).json(formatErrorResponse("Create room failed"));
  }
}

export async function getRooms(req: Request, res: Response) {
  try {
    const rooms = await Room().find({ status: 'waiting', 'settings.visibility': 'public' }).sort({ createdAt: -1 });

    const roomIds = rooms.map(r => r._id);
    const playerCounts = await RoomPlayer().aggregate([
      { $match: { roomId: { $in: roomIds } } },
      { $group: { _id: '$roomId', count: { $sum: 1 } } },
    ]);

    const countMap = new Map(playerCounts.map(pc => [pc._id.toString(), pc.count]));

    const roomsWithCounts = rooms.map(room => ({
      ...room.toObject(),
      id: room._id,
      playerCount: countMap.get(room._id.toString()) || 0,
    }));

    return res.json(formatSuccessResponse(roomsWithCounts));
  } catch (error) {
    console.error('Get rooms error:', error);
    return res.status(500).json(formatErrorResponse('Failed to fetch rooms'));
  }
}

export async function getRoomDetails(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }
    const room = await Room().findById(roomId).populate('hostId', 'displayName avatarUrl');
    if (!room) {
      return res.status(404).json(formatErrorResponse('Room not found'));
    }

    const players = await RoomPlayer().find({ roomId }).populate('userId', 'displayName avatarUrl');
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);

    const cachedState = await gameStateCache.getState(roomId, room.toObject());
    const roomView = cachedState
      ? {
          ...room.toObject(),
          status: cachedState.status,
          currentPlayerIndex: cachedState.currentPlayerIndex,
          gameBoard: {
            ...cachedState.gameBoard,
            lastRollAt: cachedState.gameBoard.lastRollAt
              ? new Date(cachedState.gameBoard.lastRollAt)
              : null,
          },
        }
      : room.toObject();

    const currentIndex = getCurrentIndex(roomView, orderedPlayers);

    return res.json(formatSuccessResponse({
        ...roomView,
        id: room._id,
        currentPlayerIndex: currentIndex,
        players: orderedPlayers.map(p => {
            const userObj = p.userId as any;
            return {
                userId: userObj._id.toString(),
                color: p.color,
                status: p.status,
                ready: p.ready,
                displayName: userObj?.displayName || "Unknown",
                avatarUrl: userObj?.avatarUrl || "",
                roomPlayerId: p._id.toString(),
            };
        }),
    }));
  } catch (error) {
    console.error('Get room details error:', error);
    return res.status(500).json(formatErrorResponse('Failed to fetch room details'));
  }
}

export async function leaveRoom(req: Request, res: Response) {
    try {
        const { roomId } = req.params;
        const userId = req.userId;
        if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
        const userIdStr = userId.toString();
        if (!isValidObjectId(roomId)) {
          return res.status(400).json(formatErrorResponse("Invalid roomId"));
        }

        const roomPlayer = await RoomPlayer().findOneAndDelete({ roomId, userId });
        if (!roomPlayer) return res.status(404).json(formatErrorResponse("Player not found"));
        
        const room = await Room().findById(roomId);
        if (room) {
            room.players.pull(roomPlayer._id);
            invalidateRoomPlayers(roomId);
            if (room.players.length === 0) {
                await Room().findByIdAndDelete(roomId);
                await gameStateCache.evict(roomId);
            } else if (room.hostId.toString() === userIdStr) {
                const newHost = await RoomPlayer().findOne({ roomId });
                if(newHost) room.hostId = newHost.userId;
            }
            await room.save();
        }
        return res.json(formatSuccessResponse({}, "Left room"));
    } catch (error) {
        console.error("Leave room error:", error);
        return res.status(500).json(formatErrorResponse("Leave room failed"));
    }
}

/* ============================================================
   GAME FLOW
============================================================ */

export async function updateRoomStatus(req: Request, res: Response) {
    // start game
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    const userIdStr = userId.toString();
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    if (room.hostId.toString() !== userIdStr) return res.status(403).json(formatErrorResponse("Only host can start"));
    if (room.status !== "waiting") return res.status(400).json(formatErrorResponse("Game already started"));

    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    if (orderedPlayers.length < 2) return res.status(400).json(formatErrorResponse("Need at least 2 players"));
    if (!orderedPlayers.every((p) => p.ready)) return res.status(400).json(formatErrorResponse("All players must be ready"));
    
    const config = getGameConfig(room.settings.maxPlayers);
    const tokens = ALL_PLAYER_COLORS.reduce<Record<PlayerColor, Token[]>>((acc, colorKey) => {
      acc[colorKey] = [];
      return acc;
    }, {} as Record<PlayerColor, Token[]>);
    for (const p of config.players) {
        tokens[p.id] = Array.from({ length: 4 }, (_, i) => ({ id: i, color: p.id, position: -1, status: "base", steps: 0 }));
    }

    const startIndex = Math.floor(Math.random() * orderedPlayers.length);
    room.status = "in_progress";
    room.currentPlayerIndex = startIndex;
    room.gameBoard.tokens = tokens;
    room.gameBoard.currentPlayerId = orderedPlayers[startIndex]._id;
    room.gameBoard.lastRollAt = null;
    room.gameBoard.gameLog.push("Game started");

    await room.save();
    await gameStateCache.primeFromRoomDoc(room);
    emitRoomUpdate(room._id.toString(), { type: "game:start" });

    return res.json(formatSuccessResponse(room.gameBoard));
  } catch (e) {
    console.error("Start game error:", e);
    return res.status(500).json(formatErrorResponse("Start game failed"));
  }
}

export async function rollDice(req: Request, res: Response) {
  try {
    const t0 = perfNow();
    const { roomId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    const userIdStr = userId.toString();
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    console.log("[rollDice] roomId", roomId, "userId", userIdStr);

    const tRoom = perfNow();
    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    logPerf("rollDice.roomLookup", tRoom);

    const tPlayers = perfNow();
    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    logPerf("rollDice.playersLookup", tPlayers, { players: orderedPlayers.length });
    const config = getGameConfig(room.settings.maxPlayers);

    const tState = perfNow();
    const payload = await gameStateCache.runExclusive(roomId, async () => {
      const state = await gameStateCache.getState(roomId, room.toObject());
      if (!state) throw new Error("STATE_NOT_FOUND");

      const currentIndex = getCurrentIndex(
        { currentPlayerIndex: state.currentPlayerIndex, gameBoard: state.gameBoard },
        orderedPlayers
      );
      const current = orderedPlayers[currentIndex];
      state.currentPlayerIndex = currentIndex;
      if (!state.gameBoard.currentPlayerId) state.gameBoard.currentPlayerId = current._id.toString();

      if (current.userId.toString() !== userIdStr) {
        if (PERF_DEBUG) {
          console.warn("[turn-mismatch][rollDice]", {
            roomId,
            expectedUserId: current.userId.toString(),
            actualUserId: userIdStr,
            currentPlayerRoomPlayerId: current._id.toString(),
            stateCurrentPlayerId: state.gameBoard.currentPlayerId,
            currentIndex,
          });
        }
        throw new Error("NOT_YOUR_TURN");
      }
      if (state.gameBoard.winners.some((w) => String(w.playerId) === current._id.toString())) {
        if (room.settings.mode !== "team") throw new Error("WINNER_CANNOT_ROLL");
      }
      if (state.gameBoard.diceValue !== null) {
        throw new Error("ALREADY_ROLLED");
      }

      const controllableColors = getControllableColors(room.settings.mode, room.settings.maxPlayers, current.color);
      const dice = generateDiceValue({
        roomId,
        playerId: current._id.toString(),
        playerColor: current.color,
        controllableColors,
        state,
        gameConfig: config,
      });
      state.gameBoard.diceValue = dice;
      state.gameBoard.lastRollAt = new Date().toISOString();

      const valid = findValidMoves(state.gameBoard.tokens, current.color, dice, config, controllableColors);
      state.gameBoard.validMoves = valid;
      reportDiceOutcome(roomId, current._id.toString(), dice, valid.length > 0);

      if (valid.length === 0) {
        state.currentPlayerIndex = advanceGameTurn(
          currentIndex,
          orderedPlayers,
          state.gameBoard as any,
          room.settings.mode !== "team"
        );
        state.gameBoard.currentPlayerId = orderedPlayers[state.currentPlayerIndex]._id.toString();
        state.gameBoard.diceValue = null;
        state.gameBoard.validMoves = [];
        state.gameBoard.lastRollAt = null;
        state.gameBoard.gameLog.push("No move, turn skipped");
      }

      await gameStateCache.markDirty(roomId, "dice:roll", false);
      return {
        dice,
        valid,
        patch: {
          revision: state.revision,
          currentPlayerIndex: state.currentPlayerIndex,
          gameBoard: {
            diceValue: state.gameBoard.diceValue,
            validMoves: state.gameBoard.validMoves,
            currentPlayerId: state.gameBoard.currentPlayerId,
            lastRollAt: state.gameBoard.lastRollAt,
          },
        },
      };
    });
    logPerf("rollDice.stateUpdate", tState);

    const tEmit = perfNow();
    emitRoomUpdate(room._id.toString(), {
      type: "dice:roll",
      dice: payload.dice,
      patch: payload.patch,
    });
    logPerf("rollDice.emit", tEmit);
    logPerf("rollDice.total", t0);
    return res.json(formatSuccessResponse(payload));
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "NOT_YOUR_TURN") return res.status(403).json(formatErrorResponse("Not your turn"));
      if (e.message === "WINNER_CANNOT_ROLL") return res.status(403).json(formatErrorResponse("Winner cannot roll"));
      if (e.message === "ALREADY_ROLLED") return res.status(400).json(formatErrorResponse("Already rolled"));
      if (e.message === "STATE_NOT_FOUND") return res.status(404).json(formatErrorResponse("Room state not found"));
    }
    console.error("Roll dice error:", e);
    return res.status(500).json(formatErrorResponse("Roll dice failed"));
  }
}

export async function getRoomCacheStatus(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }
    const room = await Room().findById(roomId).select("_id");
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));

    const diagnostics = await gameStateCache.getDiagnostics(roomId);
    return res.json(formatSuccessResponse(diagnostics));
  } catch (error) {
    console.error("Get room cache status error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch cache status"));
  }
}

/* ============================================================
   ADVANCE TURN
============================================================ */
export async function advanceTurn(req: Request, res: Response) {
  try {
    const t0 = perfNow();
    const { roomId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    const userIdStr = userId.toString();
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const tRoom = perfNow();
    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    logPerf("advanceTurn.roomLookup", tRoom);

    const tPlayers = perfNow();
    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    logPerf("advanceTurn.playersLookup", tPlayers, { players: orderedPlayers.length });

    const tState = perfNow();
    const payload = await gameStateCache.runExclusive(roomId, async () => {
      const state = await gameStateCache.getState(roomId, room.toObject());
      if (!state) throw new Error("STATE_NOT_FOUND");

      const currentIndex = getCurrentIndex(
        { currentPlayerIndex: state.currentPlayerIndex, gameBoard: state.gameBoard },
        orderedPlayers
      );
      const current = orderedPlayers[currentIndex];
      state.currentPlayerIndex = currentIndex;
      if (!state.gameBoard.currentPlayerId) state.gameBoard.currentPlayerId = current._id.toString();
      if (current.userId.toString() !== userIdStr) {
        if (PERF_DEBUG) {
          console.warn("[turn-mismatch][advanceTurn]", {
            roomId,
            expectedUserId: current.userId.toString(),
            actualUserId: userIdStr,
            currentPlayerRoomPlayerId: current._id.toString(),
            stateCurrentPlayerId: state.gameBoard.currentPlayerId,
            currentIndex,
          });
        }
        throw new Error("NOT_YOUR_TURN");
      }

      if (state.gameBoard.diceValue !== null && state.gameBoard.lastRollAt) {
        const elapsed = Date.now() - new Date(state.gameBoard.lastRollAt).getTime();
        if (elapsed < 20000) {
          throw new Error("MOVE_TIME_NOT_EXPIRED");
        }
      }

      state.currentPlayerIndex = advanceGameTurn(
        currentIndex,
        orderedPlayers,
        state.gameBoard as any,
        room.settings.mode !== "team"
      );
      state.gameBoard.currentPlayerId = orderedPlayers[state.currentPlayerIndex]._id.toString();
      state.gameBoard.diceValue = null;
      state.gameBoard.validMoves = [];
      state.gameBoard.lastRollAt = null;

      await gameStateCache.markDirty(roomId, "turn:advance", false);
      return {
        currentPlayerId: state.gameBoard.currentPlayerId,
        patch: {
          revision: state.revision,
          currentPlayerIndex: state.currentPlayerIndex,
          gameBoard: {
            currentPlayerId: state.gameBoard.currentPlayerId,
            diceValue: state.gameBoard.diceValue,
            validMoves: state.gameBoard.validMoves,
            lastRollAt: state.gameBoard.lastRollAt,
          },
        },
      };
    });
    logPerf("advanceTurn.stateUpdate", tState);

    const tEmit = perfNow();
    emitRoomUpdate(room._id.toString(), { type: "turn:advance", patch: payload.patch });
    logPerf("advanceTurn.emit", tEmit);
    logPerf("advanceTurn.total", t0);
    return res.json(formatSuccessResponse(payload, "Turn advanced"));
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "NOT_YOUR_TURN") {
        return res.status(403).json(formatErrorResponse("It is not your turn to advance"));
      }
      if (error.message === "MOVE_TIME_NOT_EXPIRED") {
        return res.status(400).json(formatErrorResponse("Move time has not expired"));
      }
      if (error.message === "STATE_NOT_FOUND") {
        return res.status(404).json(formatErrorResponse("Room state not found"));
      }
    }
    console.error("Advance turn error:", error);
    return res.status(500).json(formatErrorResponse("Failed to advance turn"));
  }
}

export async function makeMove(req: Request, res: Response) {
  try {
    const t0 = perfNow();
    const { roomId } = req.params;
    const { tokenId, color, diceValue, enterHome } = req.body;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    const userIdStr = userId.toString();
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }
    if (typeof tokenId !== "number" || !Number.isInteger(tokenId) || tokenId < 0) {
      return res.status(400).json(formatErrorResponse("Invalid tokenId"));
    }
    if (typeof diceValue !== "number" || !Number.isInteger(diceValue) || diceValue < 1 || diceValue > 6) {
      return res.status(400).json(formatErrorResponse("Invalid diceValue"));
    }
    if (typeof color !== "string" || !ALL_PLAYER_COLORS.includes(color as PlayerColor)) {
      return res.status(400).json(formatErrorResponse("Invalid color"));
    }
    const moveColor = color as PlayerColor;

    console.log("[makeMove] roomId", roomId, "userId", userIdStr, "tokenId", tokenId, "color", moveColor, "diceValue", diceValue);

    const tRoom = perfNow();
    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse('Room not found'));
    logPerf("makeMove.roomLookup", tRoom);

    const tPlayers = perfNow();
    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    logPerf("makeMove.playersLookup", tPlayers, { players: orderedPlayers.length });

    const tState = perfNow();
    const movePayload = await gameStateCache.runExclusive(roomId, async () => {
      const state = await gameStateCache.getState(roomId, room.toObject());
      if (!state) throw new Error("STATE_NOT_FOUND");

      const currentIndex = getCurrentIndex(
        { currentPlayerIndex: state.currentPlayerIndex, gameBoard: state.gameBoard },
        orderedPlayers
      );
      const current = orderedPlayers[currentIndex];
      state.currentPlayerIndex = currentIndex;
      if (!state.gameBoard.currentPlayerId) state.gameBoard.currentPlayerId = current._id.toString();

      if (current.userId.toString() !== userIdStr) {
        if (PERF_DEBUG) {
          console.warn("[turn-mismatch][makeMove]", {
            roomId,
            expectedUserId: current.userId.toString(),
            actualUserId: userIdStr,
            currentPlayerRoomPlayerId: current._id.toString(),
            stateCurrentPlayerId: state.gameBoard.currentPlayerId,
            currentIndex,
          });
        }
        throw new Error("NOT_YOUR_TURN");
      }
      if (state.gameBoard.winners.some((w) => String(w.playerId) === current._id.toString())) {
        if (room.settings.mode !== "team") throw new Error("WINNER_CANNOT_MOVE");
      }
      if (state.gameBoard.diceValue !== diceValue) throw new Error("DICE_MISMATCH");

      const config = getGameConfig(room.settings.maxPlayers);
      const controllableColors = getControllableColors(room.settings.mode, room.settings.maxPlayers, current.color);
      if (!controllableColors.includes(moveColor)) throw new Error("INVALID_TEAM_COLOR");
      const isValid = state.gameBoard.validMoves.some((m) => m.id === tokenId && m.color === moveColor);
      if (!isValid) throw new Error("INVALID_MOVE");

      const token = state.gameBoard.tokens[moveColor]?.find((t: Token) => t.id === tokenId);
      if (!token) throw new Error("TOKEN_NOT_FOUND");

      const { updatedToken, capturedToken } = applyMove(
        token,
        diceValue,
        moveColor,
        config,
        state.gameBoard.tokens,
        enterHome !== false,
        controllableColors
      );

      const newTokens: Record<PlayerColor, Token[]> = { ...(state.gameBoard.tokens || {}) };
      newTokens[moveColor] = (newTokens[moveColor] || []).map((t: Token) => (t.id === tokenId ? updatedToken : t));

      if (capturedToken) {
        newTokens[capturedToken.color] = (newTokens[capturedToken.color] || []).map((t: Token) =>
          t.id === capturedToken.id ? { ...t, position: -1, status: "base", steps: -1 } : t
        );
      }

      state.gameBoard.tokens = newTokens;

      const hasWon = checkWinCondition(state.gameBoard.tokens, moveColor);
      const moveOwner = orderedPlayers.find((p) => p.color === moveColor);
      const moveOwnerId = moveOwner?._id?.toString();
      if (hasWon && moveOwnerId && !state.gameBoard.winners.some((w) => String(w.playerId) === moveOwnerId)) {
        state.gameBoard.winners.push({ playerId: moveOwnerId, rank: state.gameBoard.winners.length + 1 });
        state.gameBoard.gameLog.push(`${moveOwner.displayName || "Player"} finished! Rank ${state.gameBoard.winners.length}`);
      }

      state.gameBoard.diceValue = null;
      state.gameBoard.validMoves = [];
      state.gameBoard.lastRollAt = null;

      const reachedHomeThisMove = token.status !== "home" && updatedToken.status === "home";
      const earnedExtraTurn = diceValue === 6 || !!capturedToken || reachedHomeThisMove;
      const gameCompleted = hasWon && state.gameBoard.winners.length >= room.settings.maxPlayers;
      if (gameCompleted) {
        state.status = "completed";
        state.gameBoard.gameLog.push("Game Over! All players finished.");
      } else if (earnedExtraTurn) {
        state.gameBoard.gameLog.push(`${current.displayName || "Player"} earned an extra turn!`);
      } else {
        state.currentPlayerIndex = advanceGameTurn(
          currentIndex,
          orderedPlayers,
          state.gameBoard as any,
          room.settings.mode !== "team"
        );
        state.gameBoard.currentPlayerId = orderedPlayers[state.currentPlayerIndex]._id.toString();
      }

      await gameStateCache.markDirty(roomId, "move", gameCompleted);
      const tokenPatch: Partial<Record<PlayerColor, Token[]>> = {
        [moveColor]: newTokens[moveColor],
      };
      if (capturedToken) tokenPatch[capturedToken.color] = newTokens[capturedToken.color];

      return {
        board: state.gameBoard,
        patch: {
          revision: state.revision,
          status: state.status,
          currentPlayerIndex: state.currentPlayerIndex,
          gameBoard: {
            tokens: tokenPatch,
            currentPlayerId: state.gameBoard.currentPlayerId,
            diceValue: state.gameBoard.diceValue,
            validMoves: state.gameBoard.validMoves,
            winners: state.gameBoard.winners,
            lastRollAt: state.gameBoard.lastRollAt,
          },
        },
      };
    });
    logPerf("makeMove.stateUpdate", tState);

    const tEmit = perfNow();
    emitRoomUpdate(room._id.toString(), {
      type: "move",
      color: moveColor,
      tokenId,
      diceValue,
      patch: movePayload.patch,
    });
    logPerf("makeMove.emit", tEmit);
    logPerf("makeMove.total", t0, { tokenId, color: moveColor, diceValue });
    return res.json(formatSuccessResponse(movePayload.board));
  } catch (e) {
    if (e instanceof Error) {
      if (e.message === "NOT_YOUR_TURN") return res.status(403).json(formatErrorResponse("Not your turn"));
      if (e.message === "WINNER_CANNOT_MOVE") return res.status(403).json(formatErrorResponse("Winner cannot move"));
      if (e.message === "DICE_MISMATCH") return res.status(400).json(formatErrorResponse("Dice value mismatch"));
      if (e.message === "INVALID_MOVE") return res.status(400).json(formatErrorResponse("Invalid move"));
      if (e.message === "INVALID_TEAM_COLOR") return res.status(403).json(formatErrorResponse("You can only move your team colors"));
      if (e.message === "TOKEN_NOT_FOUND") return res.status(404).json(formatErrorResponse("Token not found"));
      if (e.message === "STATE_NOT_FOUND") return res.status(404).json(formatErrorResponse("Room state not found"));
    }
    console.error("Make move error:", e);
    return res.status(500).json(formatErrorResponse("Make move failed"));
  }
}

/* ============================================================
   JOIN ROOM
============================================================ */
export async function joinRoom(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json(formatErrorResponse("Unauthorized"));
    }

    const { roomId } = req.params;
    const { code, selectedColor } = req.body as { code?: string; selectedColor?: PlayerColor };
    const hasCode = !!code && typeof code === "string";
    const hasRoomId = !!roomId && typeof roomId === "string";
    if (!hasCode && !hasRoomId) {
      return res.status(400).json(formatErrorResponse("Room code or roomId is required"));
    }
    if (hasRoomId && !isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const RoomModel = mongoose.model('Room');
    const RoomPlayerModel = mongoose.model('RoomPlayer');

    const room = hasRoomId
      ? await RoomModel.findById(roomId)
      : await RoomModel.findOne({ code: (code as string).toUpperCase() });
    if (!room) {
      return res.status(404).json(formatErrorResponse("Room not found"));
    }

    if (room.status !== "waiting") {
      return res.status(400).json(formatErrorResponse("Room is not joinable"));
    }

    const existing = await RoomPlayerModel.findOne({ roomId: room._id, userId });
    if (existing) {
      return res.status(400).json(formatErrorResponse("You are already in this room"));
    }

    const currentCount = await RoomPlayerModel.countDocuments({ roomId: room._id });
    if (currentCount >= room.settings.maxPlayers) {
      return res.status(400).json(formatErrorResponse("Room is full"));
    }

    const colors = PLAYER_COLOR_MAPS[room.settings.maxPlayers] || PLAYER_COLOR_MAPS[4];
    const usedColors = await RoomPlayerModel.find({ roomId: room._id }).select("color");
    const usedSet = new Set(usedColors.map((p: any) => p.color));

    const requestedColor = selectedColor && colors.includes(selectedColor) ? selectedColor : undefined;
    const assignedColor = requestedColor && !usedSet.has(requestedColor)
      ? requestedColor
      : colors.find(c => !usedSet.has(c));

    if (!assignedColor) {
      return res.status(400).json(formatErrorResponse("No available colors"));
    }

    const rp = await RoomPlayerModel.create({
      roomId: room._id,
      userId,
      color: assignedColor,
      ready: false,
      status: "waiting",
    });

    room.players.push(rp._id);
    await room.save();
    invalidateRoomPlayers(room._id.toString());

    return res.json(formatSuccessResponse({ roomId: room._id }, "Joined room"));
  } catch (error) {
    console.error("Join room error:", error);
    return res.status(500).json(formatErrorResponse("Failed to join room"));
  }
}

export async function togglePlayerReady(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const rp = await RoomPlayer().findOne({ roomId, userId });
    if (!rp) return res.status(404).json(formatErrorResponse("Player not found"));
    
    rp.ready = !rp.ready;
    await rp.save();
    invalidateRoomPlayers(roomId);

    return res.json(formatSuccessResponse({ ready: rp.ready }));
  } catch (e) {
    console.error("Toggle ready error:", e);
    return res.status(500).json(formatErrorResponse("Toggle ready failed"));
  }
}
