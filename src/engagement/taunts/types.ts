import { PlayerColor, Token } from "../../config/ludoConfigBackend";

export type TauntTrigger =
  | "rolled_six"
  | "released_token"
  | "captured"
  | "got_captured"
  | "narrow_escape"
  | "entered_safe"
  | "near_win"
  | "lead_change"
  | "last_place"
  | "revenge_kill"
  | "clutch_roll"
  | "blocked_opponent";

export type TauntCategory =
  | "dominance"
  | "revenge"
  | "mock_escape"
  | "appreciation"
  | "panic_reaction"
  | "pressure"
  | "comeback"
  | "clutch";

export type MatchPhase = "early" | "mid" | "late";
export type TauntMode = "suggestion" | "hybrid" | "auto";

export interface TauntLine {
  id: string;
  category: TauntCategory;
  triggers: TauntTrigger[];
  weight: number;
  text_en: string;
  text_hi: string;
}

export interface TauntPlayerSnapshot {
  roomPlayerId: string;
  userId: string;
  displayName: string;
  color: PlayerColor;
}

export interface TauntRoomSnapshot {
  roomId: string;
  mode: "individual" | "team";
  maxPlayers: number;
  players: TauntPlayerSnapshot[];
  board: {
    tokens: Record<PlayerColor, Token[]>;
    winners: Array<{ playerId: string; rank: number }>;
  };
}

export interface TauntEventInput {
  trigger: TauntTrigger;
  actorRoomPlayerId: string;
  actorUserId: string;
  targetRoomPlayerId?: string;
  targetUserId?: string;
  metadata?: Record<string, unknown>;
}

export interface TauntSuggestionItem {
  id: string;
  category: TauntCategory;
  text_en: string;
  text_hi: string;
}

export interface TauntQuickMessagePayload {
  roomId: string;
  fromUserId: string;
  toUserId: string;
  fromRoomPlayerId: string;
  toRoomPlayerId: string;
  fromDisplayName: string;
  toDisplayName: string;
  kind: "appreciate" | "revenge" | "taunt";
  text: string;
  ts: number;
}

