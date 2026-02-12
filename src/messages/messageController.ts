import { Request, Response } from "express";
import { formatErrorResponse, formatSuccessResponse } from "../utils/helpers";
import {
  getOrCreateDirectConversation,
  listConversations,
  listMessages,
  markConversationRead,
  sendMessage,
} from "./messageService";
import { emitConversationMessageEvent, emitUserMessageEvent } from "../socket";

export async function getConversations(req: Request, res: Response) {
  try {
    const userId = req.userId?.toString();
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const conversations = await listConversations(userId);
    return res.json(formatSuccessResponse(conversations));
  } catch (error) {
    console.error("Get conversations error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch conversations"));
  }
}

export async function createDirectConversation(req: Request, res: Response) {
  try {
    const userId = req.userId?.toString();
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const participantId = String(req.body?.participantId || "");
    const conversation = await getOrCreateDirectConversation(userId, participantId);
    return res.status(201).json(formatSuccessResponse({ conversationId: String(conversation._id) }));
  } catch (error: any) {
    if (error instanceof Error) {
      if (error.message === "INVALID_PARTICIPANT_ID")
        return res.status(400).json(formatErrorResponse("Invalid participant id"));
      if (error.message === "SELF_CONVERSATION_NOT_ALLOWED")
        return res.status(400).json(formatErrorResponse("You cannot start a conversation with yourself"));
      if (error.message === "USER_NOT_FOUND")
        return res.status(404).json(formatErrorResponse("Participant not found"));
    }
    console.error("Create direct conversation error:", error);
    return res.status(500).json(formatErrorResponse("Failed to create conversation"));
  }
}

export async function getConversationMessages(req: Request, res: Response) {
  try {
    const userId = req.userId?.toString();
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const conversationId = String(req.params.conversationId || "");
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    const data = await listMessages(userId, conversationId, before, limit);
    return res.json(formatSuccessResponse(data));
  } catch (error: any) {
    if (error instanceof Error) {
      if (error.message === "INVALID_CONVERSATION_ID")
        return res.status(400).json(formatErrorResponse("Invalid conversation id"));
      if (error.message === "CONVERSATION_NOT_FOUND")
        return res.status(404).json(formatErrorResponse("Conversation not found"));
    }
    console.error("Get messages error:", error);
    return res.status(500).json(formatErrorResponse("Failed to fetch messages"));
  }
}

export async function postConversationMessage(req: Request, res: Response) {
  try {
    const userId = req.userId?.toString();
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const conversationId = String(req.params.conversationId || "");
    const text = String(req.body?.text || "");
    const payload = await sendMessage(userId, conversationId, text);

    emitConversationMessageEvent(conversationId, "messages:new", {
      conversationId,
      message: payload.message,
    });
    payload.participantIds.forEach((participantId: string) => {
      emitUserMessageEvent(participantId, "messages:new", {
        conversationId,
        message: payload.message,
      });
    });

    return res.status(201).json(formatSuccessResponse(payload));
  } catch (error: any) {
    if (error instanceof Error) {
      if (error.message === "INVALID_CONVERSATION_ID")
        return res.status(400).json(formatErrorResponse("Invalid conversation id"));
      if (error.message === "CONVERSATION_NOT_FOUND")
        return res.status(404).json(formatErrorResponse("Conversation not found"));
      if (error.message === "EMPTY_MESSAGE")
        return res.status(400).json(formatErrorResponse("Message cannot be empty"));
      if (error.message === "MESSAGE_TOO_LONG")
        return res.status(400).json(formatErrorResponse("Message too long"));
    }
    console.error("Send message error:", error);
    return res.status(500).json(formatErrorResponse("Failed to send message"));
  }
}

export async function markRead(req: Request, res: Response) {
  try {
    const userId = req.userId?.toString();
    if (!userId) return res.status(401).json(formatErrorResponse("Unauthorized"));

    const conversationId = String(req.params.conversationId || "");
    const result = await markConversationRead(userId, conversationId);

    emitConversationMessageEvent(conversationId, "messages:read", {
      conversationId,
      userId,
      readAt: result.readAt,
    });
    result.participantIds.forEach((participantId: string) => {
      emitUserMessageEvent(participantId, "messages:read", {
        conversationId,
        userId,
        readAt: result.readAt,
      });
    });

    return res.json(formatSuccessResponse(result));
  } catch (error: any) {
    if (error instanceof Error) {
      if (error.message === "INVALID_CONVERSATION_ID")
        return res.status(400).json(formatErrorResponse("Invalid conversation id"));
      if (error.message === "CONVERSATION_NOT_FOUND")
        return res.status(404).json(formatErrorResponse("Conversation not found"));
    }
    console.error("Mark read error:", error);
    return res.status(500).json(formatErrorResponse("Failed to mark conversation as read"));
  }
}
