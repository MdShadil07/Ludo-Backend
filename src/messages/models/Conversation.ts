import mongoose, { Document, Schema, Types } from "mongoose";

export interface ConversationParticipant {
  userId: Types.ObjectId;
  joinedAt: Date;
  lastReadAt: Date;
}

export interface ConversationDocument extends Document {
  isDirect: boolean;
  conversationKey?: string;
  createdBy: Types.ObjectId;
  participants: ConversationParticipant[];
  lastMessageText?: string;
  lastMessageAt?: Date;
  lastMessageSenderId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const participantSchema = new Schema<ConversationParticipant>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    joinedAt: { type: Date, required: true, default: Date.now },
    lastReadAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new Schema<ConversationDocument>(
  {
    isDirect: { type: Boolean, required: true, default: true },
    conversationKey: { type: String, required: false, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    participants: { type: [participantSchema], required: true, validate: [(arr: unknown[]) => arr.length >= 2, "At least 2 participants required"] },
    lastMessageText: { type: String, required: false },
    lastMessageAt: { type: Date, required: false },
    lastMessageSenderId: { type: Schema.Types.ObjectId, ref: "User", required: false },
  },
  { timestamps: true }
);

conversationSchema.index({ "participants.userId": 1, updatedAt: -1 });
conversationSchema.index({ conversationKey: 1 }, { unique: true, sparse: true });

export const Conversation =
  mongoose.models.Conversation ||
  mongoose.model<ConversationDocument>("Conversation", conversationSchema);

