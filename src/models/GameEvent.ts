import mongoose, { Document, Schema, Types } from "mongoose";

export interface GameEventDocument extends Document {
  roomId: Types.ObjectId;
  type: string;
  actorUserId?: Types.ObjectId | null;
  actorRoomPlayerId?: Types.ObjectId | null;
  revision: number;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const gameEventSchema = new Schema<GameEventDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "Room", required: true, index: true },
    type: { type: String, required: true, trim: true, index: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorRoomPlayerId: { type: Schema.Types.ObjectId, ref: "RoomPlayer", default: null },
    revision: { type: Number, default: 0, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

gameEventSchema.index({ roomId: 1, createdAt: -1 });
gameEventSchema.index({ roomId: 1, type: 1, createdAt: -1 });

export const GameEvent =
  mongoose.models.GameEvent ||
  mongoose.model<GameEventDocument>("GameEvent", gameEventSchema);

