import { Types } from "mongoose";
import { User } from "../models/User";
import { Conversation } from "./models/Conversation";
import { Message } from "./models/Message";

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 30;

const toObjectId = (id: string) => new Types.ObjectId(id);

const normalizeText = (value: string) => value.replace(/\s+/g, " ").trim();

export type ConversationSummary = {
  id: string;
  isDirect: boolean;
  otherUser: {
    userId: string;
    displayName: string;
    avatarUrl: string;
    level: number;
  } | null;
  participants: string[];
  lastMessageText: string;
  lastMessageAt: number | null;
  unreadCount: number;
};

export type MessageView = {
  id: string;
  conversationId: string;
  sender: {
    userId: string;
    displayName: string;
    avatarUrl: string;
    level: number;
  };
  text: string;
  createdAt: number;
  mine: boolean;
};

function buildConversationKey(a: string, b: string) {
  return [a, b].sort().join(":");
}

async function assertUserExists(userId: string) {
  const exists = await User.exists({ _id: userId });
  if (!exists) throw new Error("USER_NOT_FOUND");
}

async function getConversationForUser(conversationId: string, userId: string) {
  if (!Types.ObjectId.isValid(conversationId)) throw new Error("INVALID_CONVERSATION_ID");
  const conversation = await Conversation.findOne({
    _id: conversationId,
    "participants.userId": userId,
  });
  if (!conversation) throw new Error("CONVERSATION_NOT_FOUND");
  return conversation;
}

function mapMessage(doc: any, currentUserId: string): MessageView {
  const sender = doc.senderId || {};
  return {
    id: String(doc._id),
    conversationId: String(doc.conversationId),
    sender: {
      userId: String(sender._id || ""),
      displayName: String(sender.displayName || "Player"),
      avatarUrl: String(sender.avatarUrl || ""),
      level: Number(sender.level || 1),
    },
    text: String(doc.text || ""),
    createdAt: new Date(doc.createdAt).getTime(),
    mine: String(sender._id || "") === currentUserId,
  };
}

export async function getOrCreateDirectConversation(currentUserId: string, otherUserId: string) {
  if (!Types.ObjectId.isValid(otherUserId)) throw new Error("INVALID_PARTICIPANT_ID");
  if (currentUserId === otherUserId) throw new Error("SELF_CONVERSATION_NOT_ALLOWED");

  await assertUserExists(otherUserId);

  const key = buildConversationKey(currentUserId, otherUserId);
  let conversation = await Conversation.findOne({ isDirect: true, conversationKey: key });
  if (!conversation) {
    const now = new Date();
    conversation = await Conversation.create({
      isDirect: true,
      conversationKey: key,
      createdBy: toObjectId(currentUserId),
      participants: [
        { userId: toObjectId(currentUserId), joinedAt: now, lastReadAt: now },
        { userId: toObjectId(otherUserId), joinedAt: now, lastReadAt: now },
      ],
    });
  }
  return conversation;
}

export async function listConversations(currentUserId: string): Promise<ConversationSummary[]> {
  const conversations = await Conversation.find({
    "participants.userId": currentUserId,
  })
    .sort({ lastMessageAt: -1, updatedAt: -1 })
    .lean();

  return Promise.all(
    conversations.map(async (conversation: any) => {
      const participantIds = (conversation.participants || []).map((p: any) => String(p.userId));
      const otherId = participantIds.find((id: string) => id !== currentUserId) || null;

      let otherUser: ConversationSummary["otherUser"] = null;
      if (otherId && Types.ObjectId.isValid(otherId)) {
        const profile = await User.findById(otherId)
          .select("displayName avatarUrl level")
          .lean();
        if (profile) {
          otherUser = {
            userId: String(profile._id),
            displayName: String(profile.displayName || "Player"),
            avatarUrl: String(profile.avatarUrl || ""),
            level: Number(profile.level || 1),
          };
        }
      }

      const participantMeta = (conversation.participants || []).find(
        (p: any) => String(p.userId) === currentUserId
      );
      const lastReadAt = participantMeta?.lastReadAt
        ? new Date(participantMeta.lastReadAt)
        : new Date(0);

      const unreadCount = await Message.countDocuments({
        conversationId: conversation._id,
        senderId: { $ne: toObjectId(currentUserId) },
        createdAt: { $gt: lastReadAt },
      });

      return {
        id: String(conversation._id),
        isDirect: Boolean(conversation.isDirect),
        otherUser,
        participants: participantIds,
        lastMessageText: String(conversation.lastMessageText || ""),
        lastMessageAt: conversation.lastMessageAt ? new Date(conversation.lastMessageAt).getTime() : null,
        unreadCount,
      };
    })
  );
}

export async function listMessages(currentUserId: string, conversationId: string, beforeTs?: number, limit?: number) {
  const conversation = await getConversationForUser(conversationId, currentUserId);
  const take = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const cursorDate = beforeTs && Number.isFinite(beforeTs) ? new Date(beforeTs) : null;

  const filter: any = { conversationId: conversation._id };
  if (cursorDate) filter.createdAt = { $lt: cursorDate };

  const rows = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(take)
    .populate("senderId", "displayName avatarUrl level")
    .lean();

  const ordered = rows.reverse();
  const nextCursor = ordered.length === take ? new Date(ordered[0].createdAt).getTime() : null;

  return {
    messages: ordered.map((row: any) => mapMessage(row, currentUserId)),
    nextCursor,
    conversationId: String(conversation._id),
  };
}

export async function sendMessage(currentUserId: string, conversationId: string, text: string) {
  const normalized = normalizeText(text);
  if (!normalized) throw new Error("EMPTY_MESSAGE");
  if (normalized.length > 1500) throw new Error("MESSAGE_TOO_LONG");

  const conversation = await getConversationForUser(conversationId, currentUserId);
  const now = new Date();

  const message = await Message.create({
    conversationId: conversation._id,
    senderId: toObjectId(currentUserId),
    text: normalized,
  });

  conversation.lastMessageText = normalized.slice(0, 280);
  conversation.lastMessageAt = now;
  conversation.lastMessageSenderId = toObjectId(currentUserId);
  conversation.participants = (conversation.participants || []).map((p: any) => {
    if (String(p.userId) === currentUserId) {
      return { ...p.toObject?.(), userId: p.userId, lastReadAt: now, joinedAt: p.joinedAt };
    }
    return p;
  });
  await conversation.save();

  const hydrated = await Message.findById(message._id)
    .populate("senderId", "displayName avatarUrl level")
    .lean();
  if (!hydrated) throw new Error("MESSAGE_NOT_FOUND");

  return {
    conversationId: String(conversation._id),
    participantIds: (conversation.participants || []).map((p: any) => String(p.userId)),
    message: mapMessage(hydrated, currentUserId),
  };
}

export async function markConversationRead(currentUserId: string, conversationId: string) {
  const conversation = await getConversationForUser(conversationId, currentUserId);
  const latest = await Message.findOne({ conversationId: conversation._id })
    .sort({ createdAt: -1 })
    .lean();
  const readAt = latest?.createdAt ? new Date(latest.createdAt) : new Date();

  await Conversation.updateOne(
    { _id: conversation._id, "participants.userId": toObjectId(currentUserId) },
    { $set: { "participants.$.lastReadAt": readAt } }
  );

  return {
    conversationId: String(conversation._id),
    participantIds: (conversation.participants || []).map((p: any) => String(p.userId)),
    readAt: readAt.getTime(),
  };
}

export async function isConversationParticipant(currentUserId: string, conversationId: string) {
  if (!Types.ObjectId.isValid(conversationId)) return false;
  const conversation = await Conversation.exists({
    _id: conversationId,
    "participants.userId": currentUserId,
  });
  return Boolean(conversation);
}

