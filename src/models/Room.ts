import mongoose, { Schema, Document, Types } from "mongoose";
import { PlayerColor, Token } from "../config/ludoConfigBackend";
import { DEFAULT_ENGAGEMENT_PROFILE, EngagementProfileName } from "../game-logic/engagement-engine/tuning";

/**
 * Player finishing result
 */
export interface PlayerScore {
  playerId: Types.ObjectId; // RoomPlayer id
  rank: number;
}

/**
 * Entire game runtime state
 */
export interface GameBoard {
  tokens: Record<PlayerColor, Token[]>;

  currentPlayerId: Types.ObjectId | null;

  diceValue: number | null;

  validMoves: { id: number; color: PlayerColor }[];

  gameLog: string[];

  winners: PlayerScore[];

  lastRollAt: Date | null;
}

/**
 * Room
 */
export interface RoomDocument extends Document {
  code: string;
  hostId: Types.ObjectId;
  players: Types.ObjectId[];

  settings: {
    maxPlayers: number;
    mode: "individual" | "team";
    visibility: "public" | "private";
    teamNames?: string[];
    tuningProfile?: EngagementProfileName;
    tauntMode?: "suggestion" | "hybrid" | "auto";
  };

  status: "waiting" | "in_progress" | "completed";

  currentPlayerIndex: number;

  gameBoard: GameBoard;

  createdAt: Date;
  updatedAt: Date;
}

/**
 * Schema
 */
const roomSchema = new Schema<RoomDocument>(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      index: true,
    },

    hostId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    players: [
      {
        type: Schema.Types.ObjectId,
        ref: "RoomPlayer",
      },
    ],

    settings: {
      maxPlayers: {
        type: Number,
        required: true,
        min: 2,
        max: 6,
      },
      mode: {
        type: String,
        enum: ["individual", "team"],
        default: "individual",
      },
      visibility: {
        type: String,
        enum: ["public", "private"],
        default: "public",
      },
      teamNames: {
        type: [String],
        default: [],
      },
      tuningProfile: {
        type: String,
        enum: ["fast_game", "competitive", "casual", "beginner_help", "event_mode"],
        default: DEFAULT_ENGAGEMENT_PROFILE,
      },
      tauntMode: {
        type: String,
        enum: ["suggestion", "hybrid", "auto"],
        default: "hybrid",
      },
    },

    status: {
      type: String,
      enum: ["waiting", "in_progress", "completed"],
      default: "waiting",
      index: true,
    },

    currentPlayerIndex: {
      type: Number,
      default: 0,
    },

    /**
     * 🎮 Live Game State
     */
    gameBoard: {
      tokens: {
        type: Schema.Types.Mixed,
        default: {},
      },

      currentPlayerId: {
        type: Schema.Types.ObjectId,
        ref: "RoomPlayer",
        default: null,
      },

      diceValue: {
        type: Number,
        default: null,
      },

      validMoves: [
        {
          id: Number,
          color: String,
        },
      ],

      gameLog: {
        type: [String],
        default: [],
      },

      winners: [
        {
          playerId: {
            type: Schema.Types.ObjectId,
            ref: "RoomPlayer",
          },
          rank: Number,
        },
      ],
      lastRollAt: {
        type: Date,
        default: null,
      },
    },
  },
  {
    timestamps: true,
  }
);

roomSchema.index({ "settings.visibility": 1, status: 1, createdAt: -1 });
roomSchema.index({ hostId: 1, status: 1, createdAt: -1 });

export default mongoose.model<RoomDocument>("Room", roomSchema);
