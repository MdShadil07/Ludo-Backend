import mongoose from "mongoose";
import { PlayerColor, PLAYER_COLOR_MAPS } from "../config/ludoConfigBackend";

type CachedPlayer = {
  _id: string;
  userId: string;
  color: PlayerColor;
  ready: boolean;
  status: string;
  displayName?: string;
};

const RoomPlayer = () => mongoose.model("RoomPlayer");

const TTL_MS = Number(process.env.ROOM_PLAYERS_CACHE_TTL_MS || 15000);
const cache = new Map<string, { expiresAt: number; players: CachedPlayer[] }>();

const getColorOrder = (maxPlayers: number) => PLAYER_COLOR_MAPS[maxPlayers] || PLAYER_COLOR_MAPS[4];

const sortPlayersByColor = (players: CachedPlayer[], maxPlayers: number) => {
  const order = getColorOrder(maxPlayers);
  const orderIndex = new Map(order.map((c, i) => [c, i]));
  return [...players].sort((a, b) => {
    const aIdx = orderIndex.get(a.color as PlayerColor) ?? 999;
    const bIdx = orderIndex.get(b.color as PlayerColor) ?? 999;
    return aIdx - bIdx;
  });
};

export async function getOrderedRoomPlayers(roomId: string, maxPlayers: number): Promise<CachedPlayer[]> {
  const now = Date.now();
  const hit = cache.get(roomId);
  if (hit && hit.expiresAt > now) return hit.players;

  const dbPlayers = await RoomPlayer().find({ roomId }).lean();
  const players = dbPlayers.map((p: any) => ({
    _id: String(p._id),
    userId: String(p.userId),
    color: p.color as PlayerColor,
    ready: !!p.ready,
    status: String(p.status || ""),
  }));
  const ordered = sortPlayersByColor(players, maxPlayers);
  cache.set(roomId, { expiresAt: now + TTL_MS, players: ordered });
  return ordered;
}

export function invalidateRoomPlayers(roomId: string): void {
  cache.delete(roomId);
}

