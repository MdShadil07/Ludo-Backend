import { Express, Router } from "express";
import authRoutes from "../../routes/authRoutes";
import profileRoutes from "../../routes/profileRoutes";
import roomRoutes from "../../routes/roomRoutes";
import messageRoutes from "../../messages/messageRoutes";

interface HttpModule {
  name: string;
  basePath: string;
  router: Router;
}

const HTTP_MODULES: HttpModule[] = [
  { name: "auth", basePath: "/api/auth", router: authRoutes },
  { name: "profile", basePath: "/api/profile", router: profileRoutes },
  { name: "rooms", basePath: "/api/rooms", router: roomRoutes },
  { name: "messages", basePath: "/api/messages", router: messageRoutes },
];

export function registerHttpModules(app: Express) {
  HTTP_MODULES.forEach((moduleDef) => {
    app.use(moduleDef.basePath, moduleDef.router);
  });
}
