import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
import { PlayerColor, Token, PLAYER_COLOR_MAPS, ALL_PLAYER_COLORS, SAFE_INDICES, getGameConfig } from "../config/ludoConfigBackend";
import { findValidMoves, applyMove, checkWinCondition, advanceTurn as advanceGameTurn } from "../services/ludoGameLogicBackend";
import { generateRoomCode, formatErrorResponse, formatSuccessResponse } from "../utils/helpers";
import { emitRoomUpdate } from "../socket";
import { gameStateCache } from "../state/gameStateCache";
import { invalidateRoomPlayers } from "../state/roomPlayersCache";
import { generateDiceValue, reportCaptureOutcome, reportDiceOutcome } from "../game-logic/engagement-engine";
import { engagementStateCache } from "../game-logic/engagement-engine/engagementStateCache";
import { DEFAULT_ENGAGEMENT_PROFILE, ENGAGEMENT_TUNING_PROFILES } from "../game-logic/engagement-engine/tuning";
import { syncRoomTeams } from "../services/roomTeamService";
import { recordGameEvent } from "../services/gameEventService";
import { processTauntEvents, isRevengeKill, recordTauntCaptureMemory } from "../engagement/taunts";
import { TauntEventInput, TauntRoomSnapshot } from "../engagement/taunts/types";

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
const RoomTeam = () => mongoose.model('RoomTeam');
const GameEvent = () => mongoose.model('GameEvent');
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

const sortPlayersBySlot = (players: any[], maxPlayers: number) => {
  const fallbackOrder = getColorOrder(maxPlayers);
  const fallbackIndex = new Map(fallbackOrder.map((c, i) => [c, i]));
  return [...players].sort((a, b) => {
    const aPos = typeof a.position === "number" ? a.position : (fallbackIndex.get(a.color as PlayerColor) ?? 999);
    const bPos = typeof b.position === "number" ? b.position : (fallbackIndex.get(b.color as PlayerColor) ?? 999);
    return aPos - bPos;
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

const resolveTeamIndex = (
  mode: "individual" | "team",
  maxPlayers: number,
  position: number,
): number | null => {
  if (mode !== "team" || maxPlayers < 4 || maxPlayers % 2 !== 0) return null;
  if (!Number.isInteger(position) || position < 0 || position >= maxPlayers) return null;
  return position % (maxPlayers / 2);
};

const toTauntRoomSnapshot = (
  roomId: string,
  room: any,
  orderedPlayers: any[],
  tokens: Record<PlayerColor, Token[]>,
  winners: Array<{ playerId: string; rank: number }>
): TauntRoomSnapshot => ({
  roomId,
  mode: room.settings.mode,
  maxPlayers: room.settings.maxPlayers,
  players: orderedPlayers.map((p) => ({
    roomPlayerId: p._id.toString(),
    userId: p.userId.toString(),
    displayName: String(p.displayName || "Player"),
    color: p.color as PlayerColor,
  })),
  board: {
    tokens,
    winners: winners.map((w) => ({
      playerId: String(w.playerId),
      rank: Number(w.rank),
    })),
  },
});

const progressScore = (tokens: Token[] = []) =>
  tokens.reduce((sum, t) => {
    if (t.status === "base") return sum;
    if (t.status === "home" || t.status === "finished") return sum + 66;
    return sum + Math.max(0, Number(t.steps || 0));
  }, 0);

const computePlayerRankMap = (
  orderedPlayers: any[],
  tokens: Record<PlayerColor, Token[]>,
  winners: Array<{ playerId: string; rank: number }>
) => {
  const winnerRank = new Map<string, number>();
  winners.forEach((w) => winnerRank.set(String(w.playerId), Number(w.rank)));

  const rows = orderedPlayers.map((p) => ({
    roomPlayerId: p._id.toString(),
    score: progressScore(tokens[p.color as PlayerColor] || []),
    rank: winnerRank.get(p._id.toString()) || 999,
  }));

  const pending = rows.filter((r) => r.rank === 999).sort((a, b) => b.score - a.score);
  let nextRank = winners.length + 1;
  pending.forEach((r) => {
    r.rank = nextRank;
    nextRank += 1;
  });

  const map = new Map<string, number>();
  rows.forEach((r) => map.set(r.roomPlayerId, r.rank));
  return map;
};

/* ============================================================
   ROOM LIFECYCLE
============================================================ */
export async function createRoom(req: Request, res: Response) {
  try {
    const userId = req.userId;
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const {
      maxPlayers = 4,
      mode = "individual",
      visibility = "public",
      selectedColor,
      tuningProfile,
      tauntMode,
    } = req.body;
    if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 6) {
      return res.status(400).json(formatErrorResponse("maxPlayers must be between 2 and 6"));
    }
    if (mode !== "individual" && mode !== "team") {
      return res.status(400).json(formatErrorResponse("Invalid mode"));
    }
    if (mode === "team" && (maxPlayers < 4 || maxPlayers % 2 !== 0)) {
      return res.status(400).json(formatErrorResponse("Team mode requires 4 or 6 players"));
    }
    const requestedProfile =
      typeof tuningProfile === "string" ? tuningProfile.trim().toLowerCase() : DEFAULT_ENGAGEMENT_PROFILE;
    if (!ENGAGEMENT_TUNING_PROFILES[requestedProfile as keyof typeof ENGAGEMENT_TUNING_PROFILES]) {
      return res.status(400).json(formatErrorResponse("Invalid tuning profile"));
    }
    const requestedTauntMode =
      typeof tauntMode === "string" ? tauntMode.trim().toLowerCase() : "hybrid";
    if (!["suggestion", "hybrid", "auto"].includes(requestedTauntMode)) {
      return res.status(400).json(formatErrorResponse("Invalid taunt mode"));
    }

    const code = generateRoomCode();

    const teamCount = mode === "team" ? maxPlayers / 2 : 0;
    const defaultTeamNames =
      mode === "team" ? Array.from({ length: teamCount }, (_, idx) => `Team ${String.fromCharCode(65 + idx)}`) : [];

    const room = await Room().create({
      code,
      hostId: userId,
      settings: {
        maxPlayers,
        mode,
        visibility,
        teamNames: defaultTeamNames,
        tuningProfile: requestedProfile,
        tauntMode: requestedTauntMode,
      },
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
    const hostPosition = selectedColor && colors.includes(selectedColor) ? colors.indexOf(selectedColor) : 0;
    const hostColor = colors[hostPosition] || colors[0];

    const rp = await RoomPlayer().create({
      roomId: room._id,
      userId,
      color: hostColor,
      position: hostPosition,
      teamIndex: resolveTeamIndex(mode, maxPlayers, hostPosition),
    });

    room.players.push(rp._id);
    await room.save();
    await syncRoomTeams(room._id.toString());
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "room:created",
      actorUserId: userId.toString(),
      actorRoomPlayerId: rp._id.toString(),
      payload: {
        maxPlayers,
        mode,
        visibility,
      },
    });

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

    const players = await RoomPlayer().find({ roomId }).populate('userId', 'displayName avatarUrl level xp');
    if (room.settings.mode === "team") {
      await syncRoomTeams(roomId);
    }
    const teams = room.settings.mode === "team"
      ? await RoomTeam().find({ roomId }).sort({ teamIndex: 1 }).lean()
      : [];
    const orderedPlayers =
      room.settings.mode === "team" && room.status === "waiting"
        ? sortPlayersBySlot(players, room.settings.maxPlayers)
        : sortPlayersByColor(players, room.settings.maxPlayers);

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
        teams,
        players: orderedPlayers.map(p => {
            const userObj = p.userId as any;
            return {
                userId: userObj._id.toString(),
                color: p.color,
                status: p.status,
                ready: p.ready,
                displayName: userObj?.displayName || "Unknown",
                avatarUrl: userObj?.avatarUrl || "",
                level: typeof userObj?.level === "number" ? userObj.level : 1,
                xp: typeof userObj?.xp === "number" ? userObj.xp : 0,
                roomPlayerId: p._id.toString(),
                position: typeof p.position === "number" ? p.position : undefined,
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
                await RoomTeam().deleteMany({ roomId });
                await gameStateCache.evict(roomId);
            } else if (room.hostId.toString() === userIdStr) {
                const newHost = await RoomPlayer().findOne({ roomId });
                if(newHost) room.hostId = newHost.userId;
            }
            await room.save();
            await syncRoomTeams(roomId);
        }
        await recordGameEvent({
          roomId,
          type: "room:player-left",
          actorUserId: userIdStr,
          actorRoomPlayerId: roomPlayer._id.toString(),
          payload: {
            userId: userIdStr,
          },
        });
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
    await syncRoomTeams(room._id.toString());
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "game:start",
      actorUserId: userIdStr,
      revision: Number((room.gameBoard as any)?.revision || 0),
      payload: {
        currentPlayerId: room.gameBoard.currentPlayerId?.toString() || null,
        maxPlayers: room.settings.maxPlayers,
        mode: room.settings.mode,
      },
    });
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
      const dice = await generateDiceValue({
        roomId,
        playerId: current._id.toString(),
        playerColor: current.color,
        controllableColors,
        state,
        gameConfig: config,
        tuningProfile: room.settings?.tuningProfile,
      });
      state.gameBoard.diceValue = dice;
      state.gameBoard.lastRollAt = new Date().toISOString();

      const valid = findValidMoves(state.gameBoard.tokens, current.color, dice, config, controllableColors);
      state.gameBoard.validMoves = valid;
      await reportDiceOutcome(
        roomId,
        current._id.toString(),
        dice,
        valid.length > 0,
        room.settings?.tuningProfile
      );

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

      const rankMap = computePlayerRankMap(orderedPlayers, state.gameBoard.tokens, state.gameBoard.winners as any);
      const actorRoomPlayerId = current._id.toString();
      const actorRank = rankMap.get(actorRoomPlayerId) || orderedPlayers.length;
      const tauntEvents: TauntEventInput[] = [];
      if (dice === 6) {
        tauntEvents.push({
          trigger: "rolled_six",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
          metadata: {
            actorWasLast: actorRank >= orderedPlayers.length,
          },
        });
      }
      if (dice >= 5 && state.gameBoard.winners.length >= Math.max(1, orderedPlayers.length - 2)) {
        tauntEvents.push({
          trigger: "clutch_roll",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
          metadata: {
            actorWasLast: actorRank >= orderedPlayers.length,
          },
        });
      }
      if (actorRank >= orderedPlayers.length && valid.length > 0) {
        tauntEvents.push({
          trigger: "last_place",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
        });
      }

      await gameStateCache.markDirty(roomId, "dice:roll", false);
      return {
        dice,
        valid,
        actorRoomPlayerId,
        actorUserId: current.userId.toString(),
        tauntEvents,
        tauntSnapshot: {
          tokens: state.gameBoard.tokens,
          winners: state.gameBoard.winners as Array<{ playerId: string; rank: number }>,
        },
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
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "dice:roll",
      actorUserId: payload.actorUserId,
      actorRoomPlayerId: payload.actorRoomPlayerId,
      revision: payload.patch.revision,
      payload: {
        dice: payload.dice,
        validMoves: payload.valid,
      },
    });
    if (payload.tauntEvents?.length) {
      await processTauntEvents({
        room: toTauntRoomSnapshot(
          room._id.toString(),
          room,
          orderedPlayers,
          payload.tauntSnapshot.tokens,
          payload.tauntSnapshot.winners
        ),
        roomTauntMode: (room.settings as any)?.tauntMode,
        events: payload.tauntEvents,
      });
    }
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

export async function getEngagementCacheStatus(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const room = await Room().findById(roomId).select("_id");
    if (!room) {
      return res.status(404).json(formatErrorResponse("Room not found"));
    }

    const players = await RoomPlayer().find({ roomId }).select("_id");
    const playerIds = players.map((player) => player._id.toString());
    const diagnostics = await engagementStateCache.getDiagnostics(roomId, playerIds);

    return res.json(formatSuccessResponse(diagnostics));
  } catch (error) {
    console.error("Get engagement cache status error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch engagement cache status"));
  }
}

export async function getRoomTeams(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const room = await Room().findById(roomId).select("_id settings.mode settings.maxPlayers");
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));

    if (room.settings.mode !== "team") {
      return res.json(formatSuccessResponse([]));
    }

    await syncRoomTeams(roomId);
    const teams = await RoomTeam().find({ roomId }).sort({ teamIndex: 1 }).lean();
    return res.json(formatSuccessResponse(teams));
  } catch (error) {
    console.error("Get room teams error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch room teams"));
  }
}

export async function getRoomEvents(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const limitRaw = Number(req.query.limit || 50);
    const limit = Math.min(Math.max(limitRaw, 1), 200);
    if (!isValidObjectId(roomId)) {
      return res.status(400).json(formatErrorResponse("Invalid roomId"));
    }

    const room = await Room().findById(roomId).select("_id");
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));

    const events = await GameEvent()
      .find({ roomId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json(formatSuccessResponse(events));
  } catch (error) {
    console.error("Get room events error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch room events"));
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
      const next = orderedPlayers[state.currentPlayerIndex];
      state.gameBoard.diceValue = null;
      state.gameBoard.validMoves = [];
      state.gameBoard.lastRollAt = null;

      await gameStateCache.markDirty(roomId, "turn:advance", false);
      return {
        actorRoomPlayerId: current._id.toString(),
        actorUserId: current.userId.toString(),
        previousPlayerId: current._id.toString(),
        currentPlayerId: state.gameBoard.currentPlayerId,
        nextPlayerId: next._id.toString(),
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
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "turn:advance",
      actorUserId: payload.actorUserId,
      actorRoomPlayerId: payload.actorRoomPlayerId,
      revision: payload.patch.revision,
      payload: {
        previousPlayerId: payload.previousPlayerId,
        nextPlayerId: payload.nextPlayerId,
      },
    });
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
      const beforeTokens: Record<PlayerColor, Token[]> = JSON.parse(JSON.stringify(state.gameBoard.tokens || {}));
      const beforeWinners = [...(state.gameBoard.winners as Array<{ playerId: string; rank: number }>)];
      const tokenOnTrack =
        typeof token.position === "number" &&
        token.position >= 0 &&
        token.position < 52 &&
        (token.status === "active" || token.status === "safe");
      const sameCellTokenIds = tokenOnTrack
        ? (state.gameBoard.tokens[moveColor] || [])
            .filter((t: Token) => {
              const onTrack =
                typeof t.position === "number" &&
                t.position >= 0 &&
                t.position < 52 &&
                (t.status === "active" || t.status === "safe");
              return onTrack && t.position === token.position;
            })
            .map((t: Token) => t.id)
        : [tokenId];
      const forcedStackMove =
        tokenOnTrack && sameCellTokenIds.length >= 2 && !SAFE_INDICES.includes(token.position);
      if (forcedStackMove && diceValue % 2 !== 0) throw new Error("INVALID_MOVE");
      const effectiveDice = forcedStackMove ? diceValue / 2 : diceValue;
      if (effectiveDice < 1) throw new Error("INVALID_MOVE");

      const movingTokenIds = forcedStackMove ? sameCellTokenIds : [tokenId];
      const workingTokens: Record<PlayerColor, Token[]> = JSON.parse(JSON.stringify(state.gameBoard.tokens || {}));
      const mergedCaptured: { id: number; color: PlayerColor }[] = [];
      const seenCaptured = new Set<string>();
      let capturedToken: { id: number; color: PlayerColor } | undefined;
      let reachedHomeThisMove = false;
      let releasedFromBase = false;
      let enteredSafeCell = false;

      for (const movingId of movingTokenIds) {
        const movingToken = (workingTokens[moveColor] || []).find((t: Token) => t.id === movingId);
        if (!movingToken) continue;
        const beforeStatus = movingToken.status;
        const beforePosition = movingToken.position;
        const { updatedToken, capturedTokens } = applyMove(
          movingToken,
          effectiveDice,
          moveColor,
          config,
          workingTokens,
          enterHome !== false,
          controllableColors
        );
        workingTokens[moveColor] = (workingTokens[moveColor] || []).map((t: Token) =>
          t.id === movingId ? updatedToken : t
        );
        if (beforeStatus !== "home" && updatedToken.status === "home") {
          reachedHomeThisMove = true;
        }
        if (beforeStatus === "base" && updatedToken.status !== "base") {
          releasedFromBase = true;
        }
        if (
          (beforeStatus === "active" || beforeStatus === "safe") &&
          beforePosition >= 0 &&
          beforePosition < 52 &&
          updatedToken.status === "safe"
        ) {
          enteredSafeCell = true;
        }

        if (capturedTokens && capturedTokens.length > 0) {
          capturedTokens.forEach((c) => {
            const key = `${c.color}-${c.id}`;
            if (seenCaptured.has(key)) return;
            seenCaptured.add(key);
            mergedCaptured.push(c);
            if (!capturedToken) capturedToken = c;
          });
        }
      }

      if (mergedCaptured.length > 0) {
        const capturedByColor = new Map<PlayerColor, Set<number>>();
        mergedCaptured.forEach((c) => {
          if (!capturedByColor.has(c.color)) capturedByColor.set(c.color, new Set<number>());
          capturedByColor.get(c.color)!.add(c.id);
        });
        capturedByColor.forEach((capturedIds, color) => {
          workingTokens[color] = (workingTokens[color] || []).map((t: Token) =>
            capturedIds.has(t.id) ? { ...t, position: -1, status: "base", steps: -1 } : t
          );
        });
      }

      if (mergedCaptured.length > 0) {
        const capturedVictimIds = Array.from(
          new Set(
            mergedCaptured
              .map((c) => orderedPlayers.find((p) => p.color === c.color)?._id?.toString())
              .filter((value): value is string => !!value)
          )
        );
        await reportCaptureOutcome(roomId, current._id.toString(), capturedVictimIds);
      }

      state.gameBoard.tokens = workingTokens;

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
        [moveColor]: workingTokens[moveColor],
      };
      if (mergedCaptured.length > 0) {
        Array.from(new Set(mergedCaptured.map((c) => c.color))).forEach((color) => {
          tokenPatch[color] = workingTokens[color];
        });
      }

      const actorRoomPlayerId = current._id.toString();
      const rankBefore = computePlayerRankMap(orderedPlayers, beforeTokens, beforeWinners);
      const rankAfter = computePlayerRankMap(
        orderedPlayers,
        workingTokens,
        state.gameBoard.winners as Array<{ playerId: string; rank: number }>
      );
      const actorRankBefore = rankBefore.get(actorRoomPlayerId) || orderedPlayers.length;
      const actorRankAfter = rankAfter.get(actorRoomPlayerId) || orderedPlayers.length;
      const leaderBefore = Array.from(rankBefore.entries()).sort((a, b) => a[1] - b[1])[0]?.[0];

      const tauntEvents: TauntEventInput[] = [];
      if (releasedFromBase) {
        tauntEvents.push({
          trigger: "released_token",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
          metadata: {
            actorWasLast: actorRankBefore >= orderedPlayers.length,
          },
        });
      }
      if (enteredSafeCell) {
        tauntEvents.push({
          trigger: "entered_safe",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
        });
      }
      if (actorRankBefore !== 1 && actorRankAfter === 1) {
        tauntEvents.push({
          trigger: "lead_change",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
        });
      }
      if (actorRankBefore >= orderedPlayers.length && actorRankAfter < actorRankBefore) {
        tauntEvents.push({
          trigger: "last_place",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
        });
      }
      if (hasWon || state.gameBoard.winners.length >= Math.max(1, orderedPlayers.length - 1)) {
        tauntEvents.push({
          trigger: "near_win",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
        });
      }

      const capturedVictimRoomPlayerIds = Array.from(
        new Set(
          mergedCaptured
            .map((c) => orderedPlayers.find((p) => p.color === c.color)?._id?.toString())
            .filter((value): value is string => !!value)
        )
      );
      for (const victimRoomPlayerId of capturedVictimRoomPlayerIds) {
        const victim = orderedPlayers.find((p) => p._id.toString() === victimRoomPlayerId);
        if (!victim) continue;
        const revengeActive = await isRevengeKill(roomId, actorRoomPlayerId, victimRoomPlayerId);
        tauntEvents.push({
          trigger: revengeActive ? "revenge_kill" : "captured",
          actorRoomPlayerId,
          actorUserId: current.userId.toString(),
          targetRoomPlayerId: victimRoomPlayerId,
          targetUserId: victim.userId.toString(),
          metadata: {
            revengeActive,
            actorWasLast: actorRankBefore >= orderedPlayers.length,
            targetWasLeader: leaderBefore === victimRoomPlayerId,
          },
        });
        tauntEvents.push({
          trigger: "got_captured",
          actorRoomPlayerId: victimRoomPlayerId,
          actorUserId: victim.userId.toString(),
          targetRoomPlayerId: actorRoomPlayerId,
          targetUserId: current.userId.toString(),
          metadata: {
            byUser: current.userId.toString(),
          },
        });
      }

      return {
        board: state.gameBoard,
        actorRoomPlayerId,
        actorUserId: current.userId.toString(),
        capturedToken: capturedToken || null,
        capturedTokens: mergedCaptured,
        effectiveDice,
        movingTokenIds,
        earnedExtraTurn,
        gameCompleted,
        tauntEvents,
        tauntSnapshot: {
          tokens: workingTokens,
          winners: state.gameBoard.winners as Array<{ playerId: string; rank: number }>,
        },
        capturedVictimRoomPlayerIds,
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
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "move",
      actorUserId: movePayload.actorUserId,
      actorRoomPlayerId: movePayload.actorRoomPlayerId,
      revision: movePayload.patch.revision,
      payload: {
        tokenId,
        color: moveColor,
        diceValue,
        effectiveDice: movePayload.effectiveDice,
        movingTokenIds: movePayload.movingTokenIds,
        capturedToken: movePayload.capturedToken,
        capturedTokens: movePayload.capturedTokens,
        earnedExtraTurn: movePayload.earnedExtraTurn,
        gameCompleted: movePayload.gameCompleted,
      },
    });
    if (movePayload.capturedVictimRoomPlayerIds?.length) {
      for (const victimRoomPlayerId of movePayload.capturedVictimRoomPlayerIds) {
        await recordTauntCaptureMemory(room._id.toString(), movePayload.actorRoomPlayerId, victimRoomPlayerId);
      }
    }
    if (movePayload.tauntEvents?.length) {
      await processTauntEvents({
        room: toTauntRoomSnapshot(
          room._id.toString(),
          room,
          orderedPlayers,
          movePayload.tauntSnapshot.tokens,
          movePayload.tauntSnapshot.winners
        ),
        roomTauntMode: (room.settings as any)?.tauntMode,
        events: movePayload.tauntEvents,
      });
    }
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

    const usedPositions = await RoomPlayerModel.find({ roomId: room._id }).select("position color");
    const positionSet = new Set(
      usedPositions
        .map((p: any) => (typeof p.position === "number" ? p.position : colors.indexOf(p.color)))
        .filter((n: number) => n >= 0)
    );

    const requestedColor = selectedColor && colors.includes(selectedColor) ? selectedColor : undefined;
    const requestedPosition = requestedColor ? colors.indexOf(requestedColor) : -1;

    const assignedPosition =
      requestedPosition >= 0 && !positionSet.has(requestedPosition)
        ? requestedPosition
        : Array.from({ length: room.settings.maxPlayers }, (_, idx) => idx).find((idx) => !positionSet.has(idx));
    const assignedColor = typeof assignedPosition === "number" ? colors[assignedPosition] : undefined;

    if (!assignedColor) {
      return res.status(400).json(formatErrorResponse("No available colors"));
    }

    const rp = await RoomPlayerModel.create({
      roomId: room._id,
      userId,
      color: assignedColor,
      position: assignedPosition,
      teamIndex: resolveTeamIndex(room.settings.mode, room.settings.maxPlayers, assignedPosition ?? -1),
      ready: false,
      status: "waiting",
    });

    room.players.push(rp._id);
    await room.save();
    invalidateRoomPlayers(room._id.toString());
    await syncRoomTeams(room._id.toString());
    await recordGameEvent({
      roomId: room._id.toString(),
      type: "room:player-joined",
      actorUserId: userId.toString(),
      actorRoomPlayerId: rp._id.toString(),
      payload: {
        color: assignedColor,
        position: assignedPosition,
      },
    });

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
    await recordGameEvent({
      roomId,
      type: "room:player-ready",
      actorUserId: userId.toString(),
      actorRoomPlayerId: rp._id.toString(),
      payload: {
        ready: rp.ready,
      },
    });

    return res.json(formatSuccessResponse({ ready: rp.ready }));
  } catch (e) {
    console.error("Toggle ready error:", e);
    return res.status(500).json(formatErrorResponse("Toggle ready failed"));
  }
}

export async function movePlayerSlot(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    const { slotIndex } = req.body as { slotIndex?: number };

    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    if (!isValidObjectId(roomId)) return res.status(400).json(formatErrorResponse("Invalid roomId"));
    if (!Number.isInteger(slotIndex)) {
      return res.status(400).json(formatErrorResponse("slotIndex must be an integer"));
    }
    const nextSlot = slotIndex as number;

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    if (room.status !== "waiting") {
      return res.status(400).json(formatErrorResponse("Slot change allowed only before game start"));
    }
    if (room.settings.mode !== "team") {
      return res.status(400).json(formatErrorResponse("Slot change is available only in team mode"));
    }
    if (nextSlot < 0 || nextSlot >= room.settings.maxPlayers) {
      return res.status(400).json(formatErrorResponse("slotIndex out of range"));
    }

    const colors = getColorOrder(room.settings.maxPlayers);
    if (!colors.length) {
      return res.status(400).json(formatErrorResponse("Invalid room configuration"));
    }

    const myPlayer = await RoomPlayer().findOne({ roomId, userId });
    if (!myPlayer) return res.status(404).json(formatErrorResponse("Player not found"));

    const currentSlot =
      typeof myPlayer.position === "number" ? myPlayer.position : colors.indexOf(myPlayer.color as PlayerColor);
    if (currentSlot === nextSlot) {
      return res.json(formatSuccessResponse({ slotIndex: nextSlot }, "Slot unchanged"));
    }

    const targetPlayer = await RoomPlayer().findOne({ roomId, position: nextSlot });

    myPlayer.position = nextSlot;
    myPlayer.color = colors[nextSlot] || myPlayer.color;
    myPlayer.teamIndex = resolveTeamIndex(room.settings.mode, room.settings.maxPlayers, nextSlot);
    if (targetPlayer) {
      targetPlayer.position = currentSlot >= 0 ? currentSlot : undefined;
      if (currentSlot >= 0 && colors[currentSlot]) {
        targetPlayer.color = colors[currentSlot];
      }
      targetPlayer.teamIndex =
        currentSlot >= 0
          ? resolveTeamIndex(room.settings.mode, room.settings.maxPlayers, currentSlot)
          : null;
      await targetPlayer.save();
    }
    await myPlayer.save();

    invalidateRoomPlayers(roomId);
    await syncRoomTeams(roomId);
    await recordGameEvent({
      roomId,
      type: "room:slot-change",
      actorUserId: userId.toString(),
      actorRoomPlayerId: myPlayer._id.toString(),
      payload: {
        fromSlot: currentSlot,
        toSlot: nextSlot,
        swappedWithRoomPlayerId: targetPlayer?._id?.toString() || null,
      },
    });
    emitRoomUpdate(roomId, { type: "room:slot-change" });

    return res.json(formatSuccessResponse({ slotIndex: nextSlot }, "Slot updated"));
  } catch (error) {
    console.error("Move slot error:", error);
    return res.status(500).json(formatErrorResponse("Failed to update slot"));
  }
}

export async function updateTeamNames(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    const { teamNames } = req.body as { teamNames?: unknown };

    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    if (!isValidObjectId(roomId)) return res.status(400).json(formatErrorResponse("Invalid roomId"));
    if (!Array.isArray(teamNames)) {
      return res.status(400).json(formatErrorResponse("teamNames must be an array"));
    }

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    if (room.settings.mode !== "team") {
      return res.status(400).json(formatErrorResponse("Team names are available only in team mode"));
    }
    if (room.status !== "waiting") {
      return res.status(400).json(formatErrorResponse("Team names can only be changed before game starts"));
    }

    const hostId = room.hostId?.toString();
    if (hostId !== userId.toString()) {
      return res.status(403).json(formatErrorResponse("Only host can update team names"));
    }

    const expectedCount = room.settings.maxPlayers / 2;
    const normalized = teamNames
      .map((name) => (typeof name === "string" ? name.trim().slice(0, 24) : ""))
      .slice(0, expectedCount);

    while (normalized.length < expectedCount) {
      normalized.push(`Team ${String.fromCharCode(65 + normalized.length)}`);
    }

    room.settings.teamNames = normalized.map((name, idx) => name || `Team ${String.fromCharCode(65 + idx)}`);
    room.markModified("settings");
    await room.save();
    await syncRoomTeams(roomId);
    await recordGameEvent({
      roomId,
      type: "room:team-names",
      actorUserId: userId.toString(),
      revision: Number((room.gameBoard as any)?.revision || 0),
      payload: {
        teamNames: room.settings.teamNames,
      },
    });

    emitRoomUpdate(roomId, { type: "room:team-names", teamNames: room.settings.teamNames });
    return res.json(formatSuccessResponse({ teamNames: room.settings.teamNames }, "Team names updated"));
  } catch (error) {
    console.error("Update team names error:", error);
    return res.status(500).json(formatErrorResponse("Failed to update team names"));
  }
}

export async function updateRoomTuningProfile(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const userId = req.userId;
    const { tuningProfile } = req.body as { tuningProfile?: unknown };

    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));
    if (!isValidObjectId(roomId)) return res.status(400).json(formatErrorResponse("Invalid roomId"));

    const profile =
      typeof tuningProfile === "string" ? tuningProfile.trim().toLowerCase() : DEFAULT_ENGAGEMENT_PROFILE;
    if (!ENGAGEMENT_TUNING_PROFILES[profile as keyof typeof ENGAGEMENT_TUNING_PROFILES]) {
      return res.status(400).json(formatErrorResponse("Invalid tuning profile"));
    }

    const room = await Room().findById(roomId);
    if (!room) return res.status(404).json(formatErrorResponse("Room not found"));
    if (room.hostId.toString() !== userId.toString()) {
      return res.status(403).json(formatErrorResponse("Only host can update tuning profile"));
    }
    if (room.status !== "waiting") {
      return res.status(400).json(formatErrorResponse("Tuning profile can only be changed before game starts"));
    }

    room.settings.tuningProfile = profile as any;
    room.markModified("settings");
    await room.save();
    emitRoomUpdate(roomId, { type: "room:tuning-profile", tuningProfile: profile });

    return res.json(formatSuccessResponse({ tuningProfile: profile }, "Tuning profile updated"));
  } catch (error) {
    console.error("Update tuning profile error:", error);
    return res.status(500).json(formatErrorResponse("Failed to update tuning profile"));
  }
}
