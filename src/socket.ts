import { Server } from "socket.io";

let io: Server | null = null;

export const initSocket = (server: any, corsOrigin: string) => {
  io = new Server(server, {
    cors: {
      origin: corsOrigin.split(",").map(s => s.trim()).filter(Boolean),
      credentials: true,
    },
  });

  io.on("connection", socket => {
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

export const emitRoomUpdate = (roomId: string, payload?: Record<string, any>) => {
  if (!io) return;
  io.to(roomId).emit("room:update", { roomId, ...payload });
};
