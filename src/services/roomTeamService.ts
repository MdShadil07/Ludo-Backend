import mongoose from "mongoose";
import { PLAYER_COLOR_MAPS, PlayerColor } from "../config/ludoConfigBackend";

const Room = () => mongoose.model("Room");
const RoomPlayer = () => mongoose.model("RoomPlayer");
const RoomTeam = () => mongoose.model("RoomTeam");

const getColorOrder = (maxPlayers: number): PlayerColor[] =>
  PLAYER_COLOR_MAPS[maxPlayers] || PLAYER_COLOR_MAPS[4];

const getTeamIndexForPosition = (position: number, maxPlayers: number): number | null => {
  if (!Number.isInteger(position) || maxPlayers < 4 || maxPlayers % 2 !== 0) return null;
  const half = maxPlayers / 2;
  if (position < 0 || position >= maxPlayers) return null;
  return position % half;
};

const normalizeTeamName = (name: unknown, index: number): string => {
  if (typeof name !== "string") return `Team ${String.fromCharCode(65 + index)}`;
  const trimmed = name.trim().slice(0, 24);
  return trimmed || `Team ${String.fromCharCode(65 + index)}`;
};

export async function syncRoomTeams(roomId: string): Promise<void> {
  const room = (await Room().findById(roomId).lean()) as any;
  if (!room) return;

  if (room.settings?.mode !== "team" || room.settings.maxPlayers < 4 || room.settings.maxPlayers % 2 !== 0) {
    await RoomTeam().deleteMany({ roomId });
    return;
  }

  const maxPlayers = room.settings.maxPlayers;
  const teamCount = maxPlayers / 2;
  const teamNames = Array.from({ length: teamCount }, (_, idx) =>
    normalizeTeamName(room.settings?.teamNames?.[idx], idx)
  );

  const teamMetaOps = Array.from({ length: teamCount }, (_, idx) => {
    const slotIndexes = [idx, idx + teamCount];
    return {
      updateOne: {
        filter: { roomId: room._id, teamIndex: idx },
        update: { $set: { name: teamNames[idx], slotIndexes } },
        upsert: true,
      },
    };
  });
  if (teamMetaOps.length > 0) await RoomTeam().bulkWrite(teamMetaOps, { ordered: false });

  const colors = getColorOrder(maxPlayers);
  const players = (await RoomPlayer()
    .find({ roomId })
    .populate("userId", "displayName")
    .lean()) as any[];

  const grouped = new Map<number, any[]>();
  for (let idx = 0; idx < teamCount; idx += 1) grouped.set(idx, []);

  for (const p of players) {
    const fallbackPosition = colors.indexOf((p.color || "") as PlayerColor);
    const position = Number.isInteger(p.position) ? p.position : fallbackPosition;
    const teamIndex = getTeamIndexForPosition(position, maxPlayers);
    if (teamIndex === null) continue;

    const userObj = p.userId as { _id?: unknown; displayName?: string } | null;
    const userId = userObj?._id || p.userId;
    grouped.get(teamIndex)?.push({
      roomPlayerId: p._id,
      userId,
      displayName: userObj?.displayName || "Unknown",
      color: p.color || "",
      position: Number.isInteger(position) ? position : null,
    });
  }

  const memberOps = Array.from(grouped.entries()).map(([teamIndex, members]) => ({
    updateOne: {
      filter: { roomId: room._id, teamIndex },
      update: { $set: { members } },
      upsert: true,
    },
  }));
  if (memberOps.length > 0) await RoomTeam().bulkWrite(memberOps, { ordered: false });
}
