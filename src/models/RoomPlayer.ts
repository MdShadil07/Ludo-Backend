import mongoose, { Schema, Document, Types } from 'mongoose';

export interface RoomPlayerDocument extends Document {
  roomId: Types.ObjectId;
  userId: Types.ObjectId;
  color: string;
  position?: number;
  teamIndex?: number | null;
  status: 'waiting' | 'playing' | 'finished';
  ready: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const roomPlayerSchema = new Schema<RoomPlayerDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: 'Room', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    color: { type: String, default: '' },
    position: { type: Number },
    teamIndex: { type: Number, default: null },
    status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
    ready: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Create a compound index to prevent duplicate entries
roomPlayerSchema.index({ roomId: 1, userId: 1 }, { unique: true });
roomPlayerSchema.index({ roomId: 1, position: 1 });
roomPlayerSchema.index({ roomId: 1, teamIndex: 1 });
roomPlayerSchema.index({ roomId: 1, ready: 1 });

export const RoomPlayer = mongoose.model<RoomPlayerDocument>('RoomPlayer', roomPlayerSchema);
