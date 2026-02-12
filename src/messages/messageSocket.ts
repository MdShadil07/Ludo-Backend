import { Server, Socket } from "socket.io";
import { parseToken, verifyToken } from "../utils/jwt";
import { isConversationParticipant, markConversationRead, sendMessage } from "./messageService";

type Ack = (payload: Record<string, any>) => void;

function getSocketUserId(socket: Socket): string | null {
  const authTokenRaw =
    (typeof socket.handshake.auth?.token === "string" && socket.handshake.auth.token) ||
    (typeof socket.handshake.headers?.authorization === "string" &&
      socket.handshake.headers.authorization) ||
    "";

  const fromBearer = parseToken(authTokenRaw);
  const candidate = fromBearer || authTokenRaw;
  if (!candidate) return null;
  const payload = verifyToken(candidate);
  return payload?.userId || null;
}

export function registerMessageSocketHandlers(io: Server, socket: Socket) {
  const userId = getSocketUserId(socket);
  if (!userId) return;

  socket.data.userId = userId;
  socket.join(`user:${userId}`);

  socket.on("messages:subscribe", async (payload: any, ack?: Ack) => {
    try {
      const conversationId = String(payload?.conversationId || "");
      const allowed = await isConversationParticipant(userId, conversationId);
      if (!allowed) {
        ack?.({ success: false, error: "Conversation not found" });
        return;
      }
      socket.join(`conversation:${conversationId}`);
      ack?.({ success: true, conversationId });
    } catch (error) {
      ack?.({ success: false, error: "Failed to subscribe conversation" });
    }
  });

  socket.on("messages:unsubscribe", (payload: any, ack?: Ack) => {
    const conversationId = String(payload?.conversationId || "");
    if (conversationId) socket.leave(`conversation:${conversationId}`);
    ack?.({ success: true, conversationId });
  });

  socket.on("messages:send", async (payload: any, ack?: Ack) => {
    try {
      const conversationId = String(payload?.conversationId || "");
      const text = String(payload?.text || "");
      const sent = await sendMessage(userId, conversationId, text);
      const eventPayload = { conversationId, message: sent.message };

      io.to(`conversation:${conversationId}`).emit("messages:new", eventPayload);
      sent.participantIds.forEach((participantId) => {
        io.to(`user:${participantId}`).emit("messages:new", eventPayload);
      });

      ack?.({ success: true, data: eventPayload });
    } catch (error: any) {
      ack?.({ success: false, error: error?.message || "Failed to send message" });
    }
  });

  socket.on("messages:markRead", async (payload: any, ack?: Ack) => {
    try {
      const conversationId = String(payload?.conversationId || "");
      const result = await markConversationRead(userId, conversationId);
      const eventPayload = { conversationId, userId, readAt: result.readAt };

      io.to(`conversation:${conversationId}`).emit("messages:read", eventPayload);
      result.participantIds.forEach((participantId) => {
        io.to(`user:${participantId}`).emit("messages:read", eventPayload);
      });

      ack?.({ success: true, data: result });
    } catch (error: any) {
      ack?.({ success: false, error: error?.message || "Failed to mark read" });
    }
  });
}

