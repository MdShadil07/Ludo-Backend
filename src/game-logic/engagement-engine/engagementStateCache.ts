import { RedisCache } from "../../state/redisCache";

type CachedMomentumState = {
  updatedAt: number;
  recentRolls: number[];
  noMoveStreak: number;
  turnsSinceSix: number;
  turnsAllTokensInBase: number;
  powerRollCharges: number;
  revengeArmedTurns: number;
  revengeTargetColors: string[];
  luckDelta: number;
  totalRolls: number;
  lastForcedRollAt: number;
  recentlyKilledTurns: number;
  sessionAssistScore: number;
};

type RoomForceState = {
  updatedAt: number;
  forcedCount: number;
  totalRolls: number;
  startedAt: number;
};

export type StoryPhase =
  | "start"
  | "spread"
  | "fights"
  | "leader"
  | "hope"
  | "chaos"
  | "finish";

type RoomDirectorState = {
  updatedAt: number;
  totalRolls: number;
  captureCount: number;
  leaderRoomPlayerId: string | null;
  leaderChanges: number;
  comebackPulses: number;
  phase: StoryPhase;
};

const MOMENTUM_TTL_SECONDS = Number(process.env.ENGAGEMENT_MOMENTUM_TTL_SECONDS || 7200);
const ENGAGEMENT_CACHE_DEBUG = process.env.ENGAGEMENT_CACHE_DEBUG === "true";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class EngagementStateCache {
  private readonly redis = new RedisCache();
  private readonly memory = new Map<string, CachedMomentumState>();
  private readonly roomForceMemory = new Map<string, RoomForceState>();
  private readonly roomDirectorMemory = new Map<string, RoomDirectorState>();

  private key(roomId: string, playerId: string): string {
    return `ludo:engagement:${roomId}:player:${playerId}:momentum`;
  }

  private roomForceKey(roomId: string): string {
    return `ludo:engagement:${roomId}:force-state`;
  }

  private roomDirectorKey(roomId: string): string {
    return `ludo:engagement:${roomId}:story-director`;
  }

  private parseKey(key: string): { roomId: string; playerId: string } | null {
    const match = key.match(/^ludo:engagement:(.+):player:(.+):momentum$/);
    if (!match) return null;
    return { roomId: match[1], playerId: match[2] };
  }

  async init(): Promise<void> {
    await this.redis.init();
  }

  async shutdown(): Promise<void> {
    await this.redis.shutdown();
  }

  isRedisConnected(): boolean {
    return this.redis.isReady();
  }

  async getMomentum(roomId: string, playerId: string): Promise<CachedMomentumState | null> {
    const key = this.key(roomId, playerId);
    const inMemory = this.memory.get(key);
    if (inMemory) {
      if (ENGAGEMENT_CACHE_DEBUG) {
        console.log(`[engagement-cache] memory-hit room=${roomId} player=${playerId}`);
      }
      return clone(inMemory);
    }

    const fromRedis = await this.redis.getJson<CachedMomentumState>(key);
    if (!fromRedis) return null;
    this.memory.set(key, clone(fromRedis));
    if (ENGAGEMENT_CACHE_DEBUG) {
      console.log(`[engagement-cache] redis-hit room=${roomId} player=${playerId}`);
    }
    return clone(fromRedis);
  }

  async setMomentum(roomId: string, playerId: string, state: CachedMomentumState): Promise<void> {
    const key = this.key(roomId, playerId);
    const snapshot = clone(state);
    this.memory.set(key, snapshot);
    await this.redis.setJson(key, snapshot, MOMENTUM_TTL_SECONDS);
    if (ENGAGEMENT_CACHE_DEBUG) {
      console.log(`[engagement-cache] write room=${roomId} player=${playerId}`, {
        turnsSinceSix: snapshot.turnsSinceSix,
        turnsAllTokensInBase: snapshot.turnsAllTokensInBase,
        noMoveStreak: snapshot.noMoveStreak,
        powerRollCharges: snapshot.powerRollCharges,
        revengeArmedTurns: snapshot.revengeArmedTurns,
        revengeTargetColors: snapshot.revengeTargetColors,
      });
    }
  }

  async getRoomForceState(roomId: string): Promise<RoomForceState> {
    const key = this.roomForceKey(roomId);
    const inMemory = this.roomForceMemory.get(key);
    if (inMemory) return clone(inMemory);
    const fromRedis = await this.redis.getJson<RoomForceState>(key);
    if (fromRedis) {
      this.roomForceMemory.set(key, clone(fromRedis));
      return clone(fromRedis);
    }
    const now = Date.now();
    return { updatedAt: now, forcedCount: 0, totalRolls: 0, startedAt: now };
  }

  async setRoomForceState(roomId: string, state: RoomForceState): Promise<void> {
    const key = this.roomForceKey(roomId);
    const snapshot = clone(state);
    this.roomForceMemory.set(key, snapshot);
    await this.redis.setJson(key, snapshot, MOMENTUM_TTL_SECONDS);
  }

  async getRoomDirectorState(roomId: string): Promise<RoomDirectorState> {
    const key = this.roomDirectorKey(roomId);
    const inMemory = this.roomDirectorMemory.get(key);
    if (inMemory) return clone(inMemory);
    const fromRedis = await this.redis.getJson<RoomDirectorState>(key);
    if (fromRedis) {
      this.roomDirectorMemory.set(key, clone(fromRedis));
      return clone(fromRedis);
    }
    return {
      updatedAt: Date.now(),
      totalRolls: 0,
      captureCount: 0,
      leaderRoomPlayerId: null,
      leaderChanges: 0,
      comebackPulses: 0,
      phase: "start",
    };
  }

  async setRoomDirectorState(roomId: string, state: RoomDirectorState): Promise<void> {
    const key = this.roomDirectorKey(roomId);
    const snapshot = clone(state);
    this.roomDirectorMemory.set(key, snapshot);
    await this.redis.setJson(key, snapshot, MOMENTUM_TTL_SECONDS);
  }

  async getDiagnostics(roomId: string, playerIds: string[]): Promise<Record<string, unknown>> {
    const requestedIds = Array.from(new Set(playerIds.filter(Boolean)));
    const diagnostics: Array<Record<string, unknown>> = [];

    for (const playerId of requestedIds) {
      const key = this.key(roomId, playerId);
      const inMemory = this.memory.get(key) || null;
      const inRedis = await this.redis.getJson<CachedMomentumState>(key);
      const memoryUpdatedAt = inMemory ? Number(inMemory.updatedAt || 0) : null;
      const redisUpdatedAt = inRedis ? Number(inRedis.updatedAt || 0) : null;

      diagnostics.push({
        playerId,
        key,
        memoryState: inMemory ? clone(inMemory) : null,
        redisState: inRedis ? clone(inRedis) : null,
        freshness: {
          memoryUpdatedAt,
          redisUpdatedAt,
          redisIsFresh:
            memoryUpdatedAt === null
              ? redisUpdatedAt !== null
              : redisUpdatedAt !== null && redisUpdatedAt >= memoryUpdatedAt,
        },
      });
    }

    const memoryKeysInRoom = Array.from(this.memory.keys()).filter((key) => {
      const parsed = this.parseKey(key);
      return parsed?.roomId === roomId;
    });

    return {
      roomId,
      redisConnected: this.redis.isReady(),
      requestedPlayerCount: requestedIds.length,
      memoryPlayerCountForRoom: memoryKeysInRoom.length,
      players: diagnostics,
    };
  }
}

export const engagementStateCache = new EngagementStateCache();
