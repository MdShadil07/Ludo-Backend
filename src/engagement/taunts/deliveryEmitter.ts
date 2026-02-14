import { getIO } from "../../socket";
import { TauntQuickMessagePayload, TauntSuggestionItem } from "./types";

export const emitTauntSuggestions = (payload: {
  roomId: string;
  actorUserId: string;
  actorRoomPlayerId: string;
  targetUserId: string;
  targetRoomPlayerId: string;
  targetDisplayName: string;
  trigger: string;
  suggestions: TauntSuggestionItem[];
  ts: number;
  ttlMs: number;
}) => {
  const io = getIO();
  if (!io) return;
  io.to(`user:${payload.actorUserId}`).emit("room:taunt-suggestions", payload);
};

export const emitQuickTauntMessage = (payload: TauntQuickMessagePayload) => {
  const io = getIO();
  if (!io) return;
  io.to(payload.roomId).emit("room:quick-message", payload);
};

