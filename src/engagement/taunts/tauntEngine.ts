import { emitQuickTauntMessage, emitTauntSuggestions } from "./deliveryEmitter";
import { computeRanking, selectSuggestions } from "./tauntSelector";
import { tauntStateCache } from "./tauntStateCache";
import {
  TauntEventInput,
  TauntMode,
  TauntPlayerSnapshot,
  TauntQuickMessagePayload,
  TauntRoomSnapshot,
  TauntSuggestionItem,
} from "./types";

const TAUNT_ENABLED = process.env.TAUNT_SYSTEM_ENABLED !== "false";
const DEFAULT_MODE = (process.env.TAUNT_MODE || "hybrid").toLowerCase() as TauntMode;
const COOLDOWN_MS = Number(process.env.TAUNT_COOLDOWN_MS || 5000);
const LIMIT_PER_MIN = Number(process.env.TAUNT_LIMIT_PER_MIN || 6);
const AUTO_PER_3S_LIMIT = Number(process.env.TAUNT_AUTO_BURST_LIMIT || 2);
const SUGGESTION_TTL_MS = Number(process.env.TAUNT_SUGGESTION_TTL_MS || 5500);

const shouldAutoFireForTrigger = (trigger: TauntEventInput["trigger"]) => {
  return trigger === "captured" || trigger === "revenge_kill" || trigger === "near_win" || trigger === "clutch_roll";
};

const shouldSuggestForTrigger = (trigger: TauntEventInput["trigger"]) => {
  return (
    trigger === "captured" ||
    trigger === "revenge_kill" ||
    trigger === "got_captured" ||
    trigger === "entered_safe" ||
    trigger === "near_win" ||
    trigger === "lead_change" ||
    trigger === "blocked_opponent" ||
    trigger === "clutch_roll"
  );
};

const mapCategoryToKind = (category: string): "appreciate" | "revenge" | "taunt" => {
  if (category === "appreciation") return "appreciate";
  if (category === "revenge") return "revenge";
  return "taunt";
};

const pickLocalizedText = (line: TauntSuggestionItem): string => {
  return line.text_hi || line.text_en;
};

const findPlayer = (room: TauntRoomSnapshot, roomPlayerId: string): TauntPlayerSnapshot | null =>
  room.players.find((p) => p.roomPlayerId === roomPlayerId) || null;

const resolveMode = (roomModeValue?: unknown): TauntMode => {
  const value = typeof roomModeValue === "string" ? roomModeValue.toLowerCase() : "";
  if (value === "suggestion" || value === "hybrid" || value === "auto") return value as TauntMode;
  return DEFAULT_MODE;
};

const enforceWindows = (
  roomState: Awaited<ReturnType<typeof tauntStateCache.getRoomState>>,
  actorRoomPlayerId: string,
  now: number
) => {
  const actor = tauntStateCache.getPlayerState(roomState, actorRoomPlayerId);
  if (actor.cooldownUntil > now) return false;
  if (actor.sentWindow.length >= LIMIT_PER_MIN) return false;
  if (roomState.recentAutoSends.length >= AUTO_PER_3S_LIMIT) return false;
  return true;
};

const pickTargetForUntargetedEvent = (
  room: TauntRoomSnapshot,
  actorRoomPlayerId: string
): TauntPlayerSnapshot | null => {
  const ranks = computeRanking(room);
  const actorRank = ranks.find((r) => r.roomPlayerId === actorRoomPlayerId);
  if (!actorRank) return null;
  const opponents = ranks.filter((r) => r.roomPlayerId !== actorRoomPlayerId);
  if (!opponents.length) return null;
  if (actorRank.rank === 1) {
    const chasing = opponents.sort((a, b) => a.rank - b.rank)[0];
    return findPlayer(room, chasing.roomPlayerId);
  }
  const leader = opponents.sort((a, b) => a.rank - b.rank)[0];
  return findPlayer(room, leader.roomPlayerId);
};

export const processTauntEvents = async (params: {
  room: TauntRoomSnapshot;
  roomTauntMode?: unknown;
  events: TauntEventInput[];
}): Promise<void> => {
  if (!TAUNT_ENABLED || !params.events.length) return;
  const now = Date.now();
  const mode = resolveMode(params.roomTauntMode);
  const roomState = await tauntStateCache.getRoomState(params.room.roomId);
  tauntStateCache.prune(roomState, now);

  for (const rawEvent of params.events) {
    const actor = findPlayer(params.room, rawEvent.actorRoomPlayerId);
    if (!actor) continue;

    const event = { ...rawEvent };
    if (!event.targetRoomPlayerId || !event.targetUserId) {
      const target = pickTargetForUntargetedEvent(params.room, actor.roomPlayerId);
      if (target) {
        event.targetRoomPlayerId = target.roomPlayerId;
        event.targetUserId = target.userId;
      }
    }
    if (!event.targetRoomPlayerId || !event.targetUserId) continue;

    const target = findPlayer(params.room, event.targetRoomPlayerId);
    if (!target) continue;

    const suggestions = await selectSuggestions(params.room, event, now);
    if (!suggestions.length) continue;

    if ((mode === "suggestion" || mode === "hybrid") && shouldSuggestForTrigger(event.trigger)) {
      emitTauntSuggestions({
        roomId: params.room.roomId,
        actorUserId: actor.userId,
        actorRoomPlayerId: actor.roomPlayerId,
        targetUserId: target.userId,
        targetRoomPlayerId: target.roomPlayerId,
        targetDisplayName: target.displayName,
        trigger: event.trigger,
        suggestions: suggestions.slice(0, 3),
        ts: now,
        ttlMs: SUGGESTION_TTL_MS,
      });
    }

    if ((mode === "auto" || mode === "hybrid") && shouldAutoFireForTrigger(event.trigger)) {
      if (!enforceWindows(roomState, actor.roomPlayerId, now)) continue;
      const candidate = suggestions[0];
      const text = pickLocalizedText(candidate);
      const payload: TauntQuickMessagePayload = {
        roomId: params.room.roomId,
        fromUserId: actor.userId,
        toUserId: target.userId,
        fromRoomPlayerId: actor.roomPlayerId,
        toRoomPlayerId: target.roomPlayerId,
        fromDisplayName: actor.displayName,
        toDisplayName: target.displayName,
        kind: mapCategoryToKind(candidate.category),
        text,
        ts: now,
      };
      emitQuickTauntMessage(payload);
      tauntStateCache.recordAutoSend(roomState, actor.roomPlayerId, candidate.id, now, COOLDOWN_MS);
    }
  }

  await tauntStateCache.setRoomState(params.room.roomId, roomState);
};

export const recordTauntCaptureMemory = async (
  roomId: string,
  killerRoomPlayerId: string,
  victimRoomPlayerId: string
): Promise<void> => {
  if (!TAUNT_ENABLED || !killerRoomPlayerId || !victimRoomPlayerId) return;
  const now = Date.now();
  const state = await tauntStateCache.getRoomState(roomId);
  tauntStateCache.prune(state, now);
  tauntStateCache.recordCapture(state, killerRoomPlayerId, victimRoomPlayerId, now);
  await tauntStateCache.setRoomState(roomId, state);
};

export const isRevengeKill = async (
  roomId: string,
  killerRoomPlayerId: string,
  victimRoomPlayerId: string
): Promise<boolean> => {
  if (!TAUNT_ENABLED || !killerRoomPlayerId || !victimRoomPlayerId) return false;
  const state = await tauntStateCache.getRoomState(roomId);
  tauntStateCache.prune(state, Date.now());
  return tauntStateCache.isRevengeKill(state, killerRoomPlayerId, victimRoomPlayerId);
};

export const recordManualQuickMessage = async (
  roomId: string,
  fromRoomPlayerId: string
): Promise<void> => {
  if (!TAUNT_ENABLED || !roomId || !fromRoomPlayerId) return;
  const now = Date.now();
  const state = await tauntStateCache.getRoomState(roomId);
  tauntStateCache.prune(state, now);
  tauntStateCache.recordManualSend(state, fromRoomPlayerId, now);
  await tauntStateCache.setRoomState(roomId, state);
};
