import mongoose, { Schema, Document, Types } from "mongoose";
import { PlayerColor, Token } from "../config/ludoConfigBackend";

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
        max: 8,
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

export default mongoose.model<RoomDocument>("Room", roomSchema);
