import { RedisCache } from "../../state/redisCache";

type PlayerTauntState = {
  cooldownUntil: number;
  sentWindow: number[];
  recentLineIds: string[];
  manualSends: number[];
  lastLineId: string | null;
};

type RevengeState = {
  killerRoomPlayerId: string;
  victimRoomPlayerId: string;
  at: number;
};

type RoomTauntState = {
  updatedAt: number;
  players: Record<string, PlayerTauntState>;
  revenge: RevengeState[];
  recentAutoSends: number[];
};

const TAUNT_TTL_SECONDS = Number(process.env.TAUNT_STATE_TTL_SECONDS || 7200);
const TAUNT_CACHE_DEBUG = process.env.TAUNT_CACHE_DEBUG === "true";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const defaultPlayerState = (): PlayerTauntState => ({
  cooldownUntil: 0,
  sentWindow: [],
  recentLineIds: [],
  manualSends: [],
  lastLineId: null,
});

const defaultRoomState = (): RoomTauntState => ({
  updatedAt: Date.now(),
  players: {},
  revenge: [],
  recentAutoSends: [],
});

export class TauntStateCache {
  private readonly redis = new RedisCache();
  private readonly memory = new Map<string, RoomTauntState>();

  private key(roomId: string): string {
    return `ludo:taunt:${roomId}:state`;
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

  async getRoomState(roomId: string): Promise<RoomTauntState> {
    const key = this.key(roomId);
    const inMemory = this.memory.get(key);
    if (inMemory) return clone(inMemory);

    const fromRedis = await this.redis.getJson<RoomTauntState>(key);
    if (fromRedis) {
      this.memory.set(key, clone(fromRedis));
      return clone(fromRedis);
    }
    return defaultRoomState();
  }

  async setRoomState(roomId: string, state: RoomTauntState): Promise<void> {
    const key = this.key(roomId);
    const snapshot = clone({ ...state, updatedAt: Date.now() });
    this.memory.set(key, snapshot);
    await this.redis.setJson(key, snapshot, TAUNT_TTL_SECONDS);
  }

  getPlayerState(state: RoomTauntState, roomPlayerId: string): PlayerTauntState {
    if (!state.players[roomPlayerId]) {
      state.players[roomPlayerId] = defaultPlayerState();
    }
    return state.players[roomPlayerId];
  }

  prune(state: RoomTauntState, now: number): void {
    const oneMinuteAgo = now - 60_000;
    state.revenge = state.revenge.filter((entry) => entry.at >= now - 4 * 60_000);
    state.recentAutoSends = state.recentAutoSends.filter((ts) => ts >= now - 3000);

    Object.values(state.players).forEach((player) => {
      player.sentWindow = player.sentWindow.filter((ts) => ts >= oneMinuteAgo);
      player.manualSends = player.manualSends.filter((ts) => ts >= oneMinuteAgo);
      player.recentLineIds = player.recentLineIds.slice(-10);
    });
  }

  recordManualSend(state: RoomTauntState, roomPlayerId: string, now: number): void {
    const player = this.getPlayerState(state, roomPlayerId);
    player.manualSends.push(now);
    player.sentWindow.push(now);
    player.cooldownUntil = Math.max(player.cooldownUntil, now + 3000);
  }

  recordAutoSend(state: RoomTauntState, roomPlayerId: string, lineId: string, now: number, cooldownMs: number): void {
    const player = this.getPlayerState(state, roomPlayerId);
    player.cooldownUntil = now + cooldownMs;
    player.sentWindow.push(now);
    player.recentLineIds.push(lineId);
    player.lastLineId = lineId;
    state.recentAutoSends.push(now);
  }

  recordCapture(state: RoomTauntState, killerRoomPlayerId: string, victimRoomPlayerId: string, now: number): void {
    state.revenge.push({
      killerRoomPlayerId,
      victimRoomPlayerId,
      at: now,
    });
    if (TAUNT_CACHE_DEBUG) {
      console.log("[taunt] capture memory", { killerRoomPlayerId, victimRoomPlayerId, now });
    }
  }

  isRevengeKill(state: RoomTauntState, killerRoomPlayerId: string, victimRoomPlayerId: string): boolean {
    return state.revenge.some(
      (entry) =>
        entry.killerRoomPlayerId === victimRoomPlayerId &&
        entry.victimRoomPlayerId === killerRoomPlayerId
    );
  }
}

export const tauntStateCache = new TauntStateCache();

