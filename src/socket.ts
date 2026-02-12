import { Server } from "socket.io";
import { registerMessageSocketHandlers } from "./messages/messageSocket";

let io: Server | null = null;
const SOCKET_DEBUG = process.env.SOCKET_DEBUG === "true";

export const initSocket = (server: any, corsOrigin: string) => {
  io = new Server(server, {
    cors: {
      origin: corsOrigin.split(",").map(s => s.trim()).filter(Boolean),
      credentials: true,
    },
  });

  io.on("connection", socket => {
    registerMessageSocketHandlers(io as Server, socket);

    socket.on("room:join", (roomId: string) => {
      if (roomId) socket.join(roomId);
    });
    socket.on("room:leave", (roomId: string) => {
      if (roomId) socket.leave(roomId);
    });
    socket.on("room:chat", (payload: any) => {
      const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
      const message = typeof payload?.message === "string" ? payload.message.trim() : "";
      if (!roomId || !message) return;
      io?.to(roomId).emit("room:chat", {
        roomId,
        userId: String(payload?.userId || ""),
        displayName: String(payload?.displayName || "Player"),
        avatarUrl: payload?.avatarUrl || "",
        message,
        ts: Date.now(),
      });
    });
  });

  return io;
};

export const getIO = () => io;

export const emitConversationMessageEvent = (
  conversationId: string,
  eventName: string,
  payload: Record<string, any>
) => {
  if (!io) return;
  io.to(`conversation:${conversationId}`).emit(eventName, payload);
};

export const emitUserMessageEvent = (
  userId: string,
  eventName: string,
  payload: Record<string, any>
) => {
  if (!io) return;
  io.to(`user:${userId}`).emit(eventName, payload);
};

export const emitRoomUpdate = (roomId: string, payload?: Record<string, any>) => {
  if (!io) return;
  const message = { roomId, ...payload };
  if (SOCKET_DEBUG) {
    try {
      const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
      console.log(`[socket] room:update room=${roomId} type=${payload?.type || "unknown"} bytes=${bytes}`);
    } catch {}
  }
  io.to(roomId).emit("room:update", message);
};
