import { Router } from "express";
import { authMiddleware } from "../middleware/auth";
import {
  createDirectConversation,
  getConversationMessages,
  getConversations,
  markRead,
  postConversationMessage,
} from "./messageController";

const router = Router();

router.get("/conversations", authMiddleware, getConversations);
router.post("/conversations/direct", authMiddleware, createDirectConversation);
router.get("/conversations/:conversationId/messages", authMiddleware, getConversationMessages);
router.post("/conversations/:conversationId/messages", authMiddleware, postConversationMessage);
router.patch("/conversations/:conversationId/read", authMiddleware, markRead);

export default router;

