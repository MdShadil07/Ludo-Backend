import { Server, Socket } from "socket.io";
import { recordManualQuickMessage } from "../../engagement/taunts";

export function registerRoomRealtime(io: Server, socket: Socket) {
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

    io.to(roomId).emit("room:chat", {
      roomId,
      userId: String(payload?.userId || ""),
      displayName: String(payload?.displayName || "Player"),
      avatarUrl: payload?.avatarUrl || "",
      message,
      ts: Date.now(),
    });
  });

  socket.on("room:quick-message", (payload: any) => {
    const roomId = typeof payload?.roomId === "string" ? payload.roomId : "";
    const fromUserId = typeof payload?.fromUserId === "string" ? payload.fromUserId : "";
    const toUserId = typeof payload?.toUserId === "string" ? payload.toUserId : "";
    const fromRoomPlayerId = typeof payload?.fromRoomPlayerId === "string" ? payload.fromRoomPlayerId : "";
    const toRoomPlayerId = typeof payload?.toRoomPlayerId === "string" ? payload.toRoomPlayerId : "";
    const text = typeof payload?.text === "string" ? payload.text.trim() : "";
    const kind = typeof payload?.kind === "string" ? payload.kind.trim() : "taunt";
    if (!roomId || !fromUserId || !toUserId || !fromRoomPlayerId || !toRoomPlayerId || !text) return;

    io.to(roomId).emit("room:quick-message", {
      roomId,
      fromUserId,
      toUserId,
      fromRoomPlayerId,
      toRoomPlayerId,
      fromDisplayName: String(payload?.fromDisplayName || "Player"),
      toDisplayName: String(payload?.toDisplayName || "Player"),
      kind,
      text,
      ts: Date.now(),
    });
    void recordManualQuickMessage(roomId, fromRoomPlayerId);
  });
}
