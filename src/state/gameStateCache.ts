import mongoose from "mongoose";
import { PlayerColor, Token } from "../config/ludoConfigBackend";
import { RedisCache } from "./redisCache";

type WinnerEntry = { playerId: string; rank: number };

export interface RuntimeGameBoard {
  tokens: Record<PlayerColor, Token[]>;
  currentPlayerId: string | null;
  diceValue: number | null;
  validMoves: { id: number; color: PlayerColor }[];
  gameLog: string[];
  winners: WinnerEntry[];
  lastRollAt: string | null;
}

export interface RuntimeRoomState {
  roomId: string;
  status: "waiting" | "in_progress" | "completed";
  currentPlayerIndex: number;
  gameBoard: RuntimeGameBoard;
  revision: number;
  updatedAt: number;
  dirty: boolean;
  lastPersistedAt: number;
}

const Room = () => mongoose.model("Room");
const ROOM_STATE_TTL_SECONDS = Number(process.env.GAME_STATE_CACHE_TTL_SECONDS || 3600);
const MOVE_LOG_TTL_SECONDS = Number(process.env.GAME_MOVE_LOG_TTL_SECONDS || 86400);
const MOVE_LOG_MAX_ITEMS = Number(process.env.GAME_MOVE_LOG_MAX_ITEMS || 300);
const FLUSH_INTERVAL_MS = Number(process.env.GAME_STATE_FLUSH_INTERVAL_MS || 2000);
const CACHE_DEBUG = process.env.GAME_CACHE_DEBUG === "true";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizeGameBoard = (raw: any): RuntimeGameBoard => {
  const board = clone(raw || {});
  const winners = Array.isArray(board.winners)
    ? board.winners.map((w: any) => ({
        playerId: String(w?.playerId ?? ""),
        rank: Number(w?.rank ?? 0),
      }))
    : [];

  const lastRoll = board.lastRollAt ? new Date(board.lastRollAt).toISOString() : null;

  return {
    tokens: (board.tokens || {}) as Record<PlayerColor, Token[]>,
    currentPlayerId: board.currentPlayerId ? String(board.currentPlayerId) : null,
    diceValue: typeof board.diceValue === "number" ? board.diceValue : null,
    validMoves: Array.isArray(board.validMoves) ? board.validMoves : [],
    gameLog: Array.isArray(board.gameLog) ? board.gameLog : [],
    winners,
    lastRollAt: lastRoll,
  };
};

const normalizeRoomToState = (roomId: string, roomLike: any): RuntimeRoomState => {
  return {
    roomId,
    status: (roomLike.status || "waiting") as "waiting" | "in_progress" | "completed",
    currentPlayerIndex: Number(roomLike.currentPlayerIndex ?? 0),
    gameBoard: normalizeGameBoard(roomLike.gameBoard),
    revision: Number(roomLike?.gameBoard?.revision ?? 0),
    updatedAt: Date.now(),
    dirty: false,
    lastPersistedAt: Date.now(),
  };
};

export class GameStateCache {
  private readonly roomStates = new Map<string, RuntimeRoomState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly redis = new RedisCache();
  private flushTimer: NodeJS.Timeout | null = null;

  private stateKey(roomId: string): string {
    return `ludo:room:${roomId}:state`;
  }

  private logKey(roomId: string): string {
    return `ludo:room:${roomId}:moves`;
  }

  async init(): Promise<void> {
    await this.redis.init();
    this.flushTimer = setInterval(() => {
      void this.flushDirtyRooms();
    }, FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer.unref === "function") {
      this.flushTimer.unref();
    }
  }

  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flushDirtyRooms(true);
    await this.redis.shutdown();
  }

  async runExclusive<T>(roomId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.queues.set(roomId, next);

    try {
      return await next;
    } finally {
      if (this.queues.get(roomId) === next) {
        this.queues.delete(roomId);
      }
    }
  }

  async getState(roomId: string, roomDocFallback?: any): Promise<RuntimeRoomState | null> {
    const inMemory = this.roomStates.get(roomId);
    if (inMemory) return inMemory;

    const fromRedis = await this.redis.getJson<RuntimeRoomState>(this.stateKey(roomId));
    if (fromRedis) {
      const hydrated = {
        ...fromRedis,
        roomId,
        revision: Number(fromRedis.revision ?? 0),
        dirty: false,
        updatedAt: Date.now(),
        lastPersistedAt: Date.now(),
      };
      this.roomStates.set(roomId, hydrated);
      return hydrated;
    }

    const roomDoc = roomDocFallback || (await Room().findById(roomId).lean());
    if (!roomDoc) return null;

    const state = normalizeRoomToState(roomId, roomDoc);
    this.roomStates.set(roomId, state);
    await this.redis.setJson(this.stateKey(roomId), state, ROOM_STATE_TTL_SECONDS);
    return state;
  }

  async primeFromRoomDoc(roomDoc: any): Promise<void> {
    if (!roomDoc?._id) return;
    const roomId = String(roomDoc._id);
    const state = normalizeRoomToState(roomId, roomDoc.toObject ? roomDoc.toObject() : roomDoc);
    this.roomStates.set(roomId, state);
    await this.redis.setJson(this.stateKey(roomId), state, ROOM_STATE_TTL_SECONDS);
  }

  async markDirty(roomId: string, event?: string, flushNow = false): Promise<void> {
    const state = this.roomStates.get(roomId);
    if (!state) return;

    state.updatedAt = Date.now();
    state.dirty = true;
    state.revision = Number(state.revision || 0) + 1;

    await this.redis.setJson(this.stateKey(roomId), state, ROOM_STATE_TTL_SECONDS);
    if (event) {
      await this.redis.pushLog(
        this.logKey(roomId),
        { ts: Date.now(), event, revision: state.revision },
        MOVE_LOG_MAX_ITEMS,
        MOVE_LOG_TTL_SECONDS
      );
    }

    if (CACHE_DEBUG) {
      console.log(
        `[cache] markDirty room=${roomId} event=${event || "unknown"} revision=${state.revision} dirty=${state.dirty}`
      );
    }

    if (flushNow) {
      await this.flushRoom(roomId);
    }
  }

  async evict(roomId: string): Promise<void> {
    this.roomStates.delete(roomId);
  }

  private async flushDirtyRooms(force = false): Promise<void> {
    const roomIds = Array.from(this.roomStates.keys());
    for (const roomId of roomIds) {
      const state = this.roomStates.get(roomId);
      if (!state) continue;
      if (!force && !state.dirty) continue;
      await this.flushRoom(roomId);
    }
  }

  async flushRoom(roomId: string): Promise<void> {
    const state = this.roomStates.get(roomId);
    if (!state || !state.dirty) return;

    const gameBoardForDb = {
      ...state.gameBoard,
      revision: state.revision,
      currentPlayerId: state.gameBoard.currentPlayerId || null,
      winners: state.gameBoard.winners.map((w) => ({
        playerId: w.playerId,
        rank: w.rank,
      })),
      lastRollAt: state.gameBoard.lastRollAt ? new Date(state.gameBoard.lastRollAt) : null,
    };

    await Room().updateOne(
      { _id: roomId },
      {
        $set: {
          status: state.status,
          currentPlayerIndex: state.currentPlayerIndex,
          gameBoard: gameBoardForDb,
        },
      }
    );

    state.dirty = false;
    state.lastPersistedAt = Date.now();
    if (CACHE_DEBUG) {
      console.log(
        `[cache] flush room=${roomId} revision=${state.revision} persistedAt=${state.lastPersistedAt}`
      );
    }
  }

  async getDiagnostics(roomId: string): Promise<Record<string, unknown>> {
    const inMemory = this.roomStates.get(roomId) || null;
    const inRedis = await this.redis.getJson<RuntimeRoomState>(this.stateKey(roomId));
    const memoryRevision = inMemory ? Number(inMemory.revision ?? 0) : null;
    const redisRevision = inRedis ? Number(inRedis.revision ?? 0) : null;

    return {
      roomId,
      redisConnected: this.redis.isReady(),
      revisionCheck: {
        memoryRevision,
        redisRevision,
        redisIsFresh:
          memoryRevision === null
            ? true
            : redisRevision !== null && redisRevision >= memoryRevision,
      },
      inMemory: inMemory
        ? {
            revision: inMemory.revision,
            status: inMemory.status,
            dirty: inMemory.dirty,
            updatedAt: inMemory.updatedAt,
            lastPersistedAt: inMemory.lastPersistedAt,
            diceValue: inMemory.gameBoard?.diceValue ?? null,
            currentPlayerId: inMemory.gameBoard?.currentPlayerId ?? null,
          }
        : null,
      redisState: inRedis
        ? {
            revision: Number(inRedis.revision ?? 0),
            status: inRedis.status,
            updatedAt: inRedis.updatedAt,
            dirty: inRedis.dirty,
            diceValue: inRedis.gameBoard?.diceValue ?? null,
            currentPlayerId: inRedis.gameBoard?.currentPlayerId ?? null,
          }
        : null,
    };
  }

  isRedisConnected(): boolean {
    return this.redis.isReady();
  }
}

export const gameStateCache = new GameStateCache();
