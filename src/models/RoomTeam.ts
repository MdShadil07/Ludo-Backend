import mongoose, { Document, Schema, Types } from "mongoose";

interface TeamMemberSnapshot {
  roomPlayerId: Types.ObjectId;
  userId: Types.ObjectId;
  displayName: string;
  color: string;
  position: number | null;
}

export interface RoomTeamDocument extends Document {
  roomId: Types.ObjectId;
  teamIndex: number;
  name: string;
  slotIndexes: number[];
  members: TeamMemberSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

const teamMemberSchema = new Schema<TeamMemberSnapshot>(
  {
    roomPlayerId: { type: Schema.Types.ObjectId, ref: "RoomPlayer", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    displayName: { type: String, required: true, trim: true },
    color: { type: String, required: true, trim: true },
    position: { type: Number, default: null },
  },
  { _id: false }
);

const roomTeamSchema = new Schema<RoomTeamDocument>(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "Room", required: true, index: true },
    teamIndex: { type: Number, required: true, min: 0 },
    name: { type: String, required: true, trim: true, maxlength: 24 },
    slotIndexes: { type: [Number], default: [] },
    members: { type: [teamMemberSchema], default: [] },
  },
  { timestamps: true }
);

roomTeamSchema.index({ roomId: 1, teamIndex: 1 }, { unique: true });

export const RoomTeam =
  mongoose.models.RoomTeam ||
  mongoose.model<RoomTeamDocument>("RoomTeam", roomTeamSchema);

