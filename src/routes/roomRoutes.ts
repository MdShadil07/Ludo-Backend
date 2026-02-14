import { Router } from "express";
import { authMiddleware } from "../middleware/auth";

import {
  createRoom,
  getRooms,
  getRoomDetails,
  getRoomCacheStatus,
  getEngagementCacheStatus,
  getRoomEvents,
  getRoomTeams,
  updateRoomStatus,   // start game
  advanceTurn,
  rollDice,
  makeMove,
  joinRoom,
  leaveRoom,
  togglePlayerReady,
  movePlayerSlot,
  updateTeamNames,
  updateRoomTuningProfile,
} from "../controllers/roomController";

const router = Router();

/* ============================================================
   ROOM LIFECYCLE
============================================================ */
router.post("/", authMiddleware, createRoom);
router.get("/", getRooms);
router.get("/:roomId", getRoomDetails);
router.get("/:roomId/cache-status", authMiddleware, getRoomCacheStatus);
router.get("/:roomId/engagement-cache-status", authMiddleware, getEngagementCacheStatus);
router.get("/:roomId/teams", authMiddleware, getRoomTeams);
router.get("/:roomId/events", authMiddleware, getRoomEvents);

// Join by room code (preferred)
router.post("/join", authMiddleware, joinRoom);
// Back-compat: join by roomId
router.post("/:roomId/join", authMiddleware, joinRoom);

// Leave room (preferred)
router.delete("/:roomId", authMiddleware, leaveRoom);
// Back-compat: leave via POST
router.post("/:roomId/leave", authMiddleware, leaveRoom);

/* ============================================================
   PLAYER READY
============================================================ */
router.patch("/:roomId/ready", authMiddleware, togglePlayerReady);
router.patch("/:roomId/slot", authMiddleware, movePlayerSlot);
router.patch("/:roomId/team-names", authMiddleware, updateTeamNames);
router.patch("/:roomId/tuning-profile", authMiddleware, updateRoomTuningProfile);

/* ============================================================
   GAME FLOW
============================================================ */
router.post("/:roomId/start", authMiddleware, updateRoomStatus);
router.post("/:roomId/next-turn", authMiddleware, advanceTurn);
router.post("/:roomId/dice", authMiddleware, rollDice);
router.post("/:roomId/move", authMiddleware, makeMove);

export default router;
