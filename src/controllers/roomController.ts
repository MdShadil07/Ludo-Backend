import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { PlayerColor, Token, PLAYER_COLOR_MAPS, ALL_PLAYER_COLORS, getGameConfig } from "../config/ludoConfigBackend";
import { findValidMoves, applyMove, checkWinCondition, advanceTurn as advanceGameTurn } from "../services/ludoGameLogicBackend";
import { generateRoomCode, formatErrorResponse, formatSuccessResponse } from "../utils/helpers";
import { emitRoomUpdate } from "../socket";

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

/* ============================================================
   ROOM LIFECYCLE
============================================================ */
export async function createRoom(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const { maxPlayers = 4, mode = "individual", visibility = "public", selectedColor } = req.body;
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

    const currentIndex = getCurrentIndex(room, orderedPlayers);

    return res.json(formatSuccessResponse({
        ...room.toObject(),
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
            if (room.players.length === 0) {
                await Room().findByIdAndDelete(roomId);
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
    emitRoomUpdate(room._id.toString(), { type: "game:start" });

    return res.json(formatSuccessResponse(room.gameBoard));
  } catch (e) {
    console.error("Start game error:", e);
    return res.status(500).json(formatErrorResponse("Start game failed"));
  }
}

export async function rollDice(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    const userIdStr = userId.toString();
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    console.log("[rollDice] roomId", roomId, "userId", userIdStr);

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));

    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    const currentIndex = getCurrentIndex(room, orderedPlayers);
    const current = orderedPlayers[currentIndex];
    room.currentPlayerIndex = currentIndex;
    if (!room.gameBoard.currentPlayerId) {
      room.gameBoard.currentPlayerId = current._id;
    }

    if (current.userId.toString() !== userIdStr) return res.status(403).json(formatErrorResponse("Not your turn"));
    if (room.gameBoard.winners.some((w: { playerId: Types.ObjectId }) => w.playerId.toString() === current._id.toString())) {
      return res.status(403).json(formatErrorResponse("Winner cannot roll"));
    }
    if (room.gameBoard.diceValue !== null) return res.status(400).json(formatErrorResponse("Already rolled"));

    const dice = Math.floor(Math.random() * 6) + 1;
    room.gameBoard.diceValue = dice;
    room.gameBoard.lastRollAt = new Date();
    
    const config = getGameConfig(room.settings.maxPlayers);
    const tokenKeys = Object.keys(room.gameBoard.tokens || {});
    console.log("[rollDice] currentColor", current.color, "dice", dice, "tokenKeys", tokenKeys);
    const valid = findValidMoves(room.gameBoard.tokens, current.color, dice, config);
    console.log("[rollDice] validMoves", valid);
    room.gameBoard.validMoves = valid;
    
    if (valid.length === 0) {
      room.currentPlayerIndex = advanceGameTurn(currentIndex, orderedPlayers, room.gameBoard);
      room.gameBoard.currentPlayerId = orderedPlayers[room.currentPlayerIndex]._id;
      room.gameBoard.diceValue = null;
      room.gameBoard.validMoves = [];
      room.gameBoard.lastRollAt = null;
      room.gameBoard.gameLog.push("No move, turn skipped");
      console.log("[rollDice] no moves, advanced to index", room.currentPlayerIndex);
    }

    await room.save();
    emitRoomUpdate(room._id.toString(), { type: "dice:roll", dice });
    return res.json(formatSuccessResponse({ dice, valid }));
  } catch (e) {
    console.error("Roll dice error:", e);
    return res.status(500).json(formatErrorResponse("Roll dice failed"));
  }
}

/* ============================================================
   ADVANCE TURN
============================================================ */
export async function advanceTurn(req: Request, res: Response) {
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

    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    const currentIndex = getCurrentIndex(room, orderedPlayers);
    const current = orderedPlayers[currentIndex];
    room.currentPlayerIndex = currentIndex;
    if (!room.gameBoard.currentPlayerId) {
      room.gameBoard.currentPlayerId = current._id;
    }
    if (current.userId.toString() !== userIdStr) {
      return res.status(403).json(formatErrorResponse("It is not your turn to advance"));
    }

    if (room.gameBoard.diceValue !== null && room.gameBoard.lastRollAt) {
      const elapsed = Date.now() - new Date(room.gameBoard.lastRollAt).getTime();
      if (elapsed < 20000) {
        return res.status(400).json(formatErrorResponse("Move time has not expired"));
      }
    }

    room.currentPlayerIndex = advanceGameTurn(currentIndex, orderedPlayers, room.gameBoard);
    room.gameBoard.currentPlayerId = orderedPlayers[room.currentPlayerIndex]._id;
    room.gameBoard.diceValue = null;
    room.gameBoard.validMoves = [];
    room.gameBoard.lastRollAt = null;

    await room.save();
    emitRoomUpdate(room._id.toString(), { type: "turn:advance" });
    return res.json(formatSuccessResponse({ currentPlayerId: room.gameBoard.currentPlayerId }, "Turn advanced"));
  } catch (error) {
    console.error("Advance turn error:", error);
    return res.status(500).json(formatErrorResponse("Failed to advance turn"));
  }
}

export async function makeMove(req: Request, res: Response) {
  try {
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

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse('Room not found'));

    const players = await RoomPlayer().find({ roomId });
    const orderedPlayers = sortPlayersByColor(players, room.settings.maxPlayers);
    const currentIndex = getCurrentIndex(room, orderedPlayers);
    const current = orderedPlayers[currentIndex];
    room.currentPlayerIndex = currentIndex;
    if (!room.gameBoard.currentPlayerId) {
      room.gameBoard.currentPlayerId = current._id;
    }

    if (current.userId.toString() !== userIdStr) return res.status(403).json(formatErrorResponse("Not your turn"));
    if (room.gameBoard.winners.some((w: { playerId: Types.ObjectId }) => w.playerId.toString() === current._id.toString())) {
      return res.status(403).json(formatErrorResponse("Winner cannot move"));
    }
    if (room.gameBoard.diceValue !== diceValue) return res.status(400).json(formatErrorResponse("Dice value mismatch"));

    const config = getGameConfig(room.settings.maxPlayers);
    const isValid = room.gameBoard.validMoves.some((m: { id: number; color: PlayerColor }) => m.id === tokenId && m.color === moveColor);
    console.log("[makeMove] validMoves", room.gameBoard.validMoves, "isValid", isValid);
    if (!isValid) return res.status(400).json(formatErrorResponse("Invalid move"));

    const token = room.gameBoard.tokens[moveColor]?.find((t: Token) => t.id === tokenId);
    if (!token) return res.status(404).json(formatErrorResponse("Token not found"));

    const { updatedToken, capturedToken } = applyMove(token, diceValue, moveColor, config, room.gameBoard.tokens, enterHome !== false);
    console.log("[makeMove] updatedToken", updatedToken);
    const newTokens: Record<PlayerColor, Token[]> = { ...(room.gameBoard.tokens || {}) };
    newTokens[moveColor] = (newTokens[moveColor] || []).map((t: Token) => (t.id === tokenId ? updatedToken : t));

    if (capturedToken) {
        newTokens[capturedToken.color] = (newTokens[capturedToken.color] || []).map((t: Token) =>
          t.id === capturedToken.id ? { ...t, position: -1, status: 'base', steps: -1 } : t
        );
    }

    room.gameBoard.tokens = newTokens;
    room.markModified("gameBoard.tokens");
    
    const hasWon = checkWinCondition(room.gameBoard.tokens, moveColor);
    if (hasWon && !room.gameBoard.winners.some((w: { playerId: Types.ObjectId }) => (w.playerId as any).equals(current._id))) {
        room.gameBoard.winners.push({ playerId: current._id, rank: room.gameBoard.winners.length + 1 });
        room.gameBoard.gameLog.push(`${current.displayName || 'Player'} finished! Rank ${room.gameBoard.winners.length}`);
    }

    room.gameBoard.diceValue = null;
    room.gameBoard.validMoves = [];
    room.gameBoard.lastRollAt = null;

    const earnedExtraTurn = diceValue === 6 || !!capturedToken;
    const gameCompleted = hasWon && room.gameBoard.winners.length >= room.settings.maxPlayers;
    if (gameCompleted) {
        room.status = 'completed';
        room.gameBoard.gameLog.push('Game Over! All players finished.');
    } else if (earnedExtraTurn) {
        room.gameBoard.gameLog.push(`${current.displayName || 'Player'} earned an extra turn!`);
    } else {
        room.currentPlayerIndex = advanceGameTurn(currentIndex, orderedPlayers, room.gameBoard);
        room.gameBoard.currentPlayerId = orderedPlayers[room.currentPlayerIndex]._id;
    }

    await room.save();
    emitRoomUpdate(room._id.toString(), { type: "move", color: moveColor, tokenId, diceValue });
    return res.json(formatSuccessResponse(room.gameBoard));
  } catch (e) {
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

    return res.json(formatSuccessResponse({ ready: rp.ready }));
  } catch (e) {
    console.error("Toggle ready error:", e);
    return res.status(500).json(formatErrorResponse("Toggle ready failed"));
  }
}
