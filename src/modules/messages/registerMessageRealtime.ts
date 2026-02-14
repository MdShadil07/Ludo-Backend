import { Server, Socket } from "socket.io";
import { registerMessageSocketHandlers } from "../../messages/messageSocket";

export function registerMessageRealtime(io: Server, socket: Socket) {
  registerMessageSocketHandlers(io, socket);
}
