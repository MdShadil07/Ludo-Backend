import mongoose, { Schema, Document } from 'mongoose';

export interface UserDocument extends Document {
  email: string;
  password?: string;
  displayName: string;
  avatarUrl: string;
  googleId?: string;
  xp: number;
  level: number;
  gamesPlayed: number;
  wins: number;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<UserDocument>(
  {
    email: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String },
    displayName: { type: String, required: true },
    avatarUrl: { type: String, default: '' },
    googleId: { type: String },
    xp: { type: Number, default: 0 },
    level: { type: Number, default: 1 },
    gamesPlayed: { type: Number, default: 0 },
    wins: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const User = mongoose.model<UserDocument>('User', userSchema);
