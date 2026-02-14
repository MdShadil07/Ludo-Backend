import { Server } from "socket.io";
import { registerMessageRealtime } from "./modules/messages/registerMessageRealtime";
import { registerRoomRealtime } from "./modules/rooms/registerRoomRealtime";

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
    registerMessageRealtime(io as Server, socket);
    registerRoomRealtime(io as Server, socket);
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
