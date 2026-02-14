import mongoose from "mongoose";

type GameEventInput = {
  roomId: string;
  type: string;
  actorUserId?: string | null;
  actorRoomPlayerId?: string | null;
  revision?: number;
  payload?: Record<string, unknown>;
};

const GameEvent = () => mongoose.model("GameEvent");

export async function recordGameEvent(input: GameEventInput): Promise<void> {
  try {
    await GameEvent().create({
      roomId: input.roomId,
      type: input.type,
      actorUserId: input.actorUserId || null,
      actorRoomPlayerId: input.actorRoomPlayerId || null,
      revision: Number(input.revision || 0),
      payload: input.payload || {},
    });
  } catch (error) {
    console.error("[game-event] failed to persist:", error);
  }
}

