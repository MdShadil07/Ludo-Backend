import mongoose, { Schema, Document, Types } from 'mongoose';

export interface RoomPlayerDocument extends Document {
  roomId: Types.ObjectId;
  userId: Types.ObjectId;
  color: string;
  position?: number;
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
    status: { type: String, enum: ['waiting', 'playing', 'finished'], default: 'waiting' },
    ready: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Create a compound index to prevent duplicate entries
roomPlayerSchema.index({ roomId: 1, userId: 1 }, { unique: true });

export const RoomPlayer = mongoose.model<RoomPlayerDocument>('RoomPlayer', roomPlayerSchema);
