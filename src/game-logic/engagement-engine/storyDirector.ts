import { DiceContext } from "./contextAnalyzer";
import { engagementStateCache, StoryPhase } from "./engagementStateCache";
import { RankContext } from "./rankingCalculator";

const STORY_DIRECTOR_DEBUG = process.env.ENGAGEMENT_STORY_DEBUG === "true";

export type StorySnapshot = {
  phase: StoryPhase;
  totalRolls: number;
  captureCount: number;
  leaderChanges: number;
  comebackPulses: number;
};

const decidePhase = (input: {
  totalRolls: number;
  captureCount: number;
  leaderChanges: number;
  comebackPulses: number;
  rank: RankContext;
}) => {
  const { totalRolls, captureCount, leaderChanges, comebackPulses, rank } = input;
  if (rank.anyPlayerNearWin) return "finish" as const;
  if (totalRolls <= 6) return "start" as const;
  if (totalRolls <= 14) return "spread" as const;
  if (captureCount <= 1) return "leader" as const;
  if (rank.behindGap > 0 && (rank.closeChase || comebackPulses > 0)) return "hope" as const;
  if (captureCount >= 4 || leaderChanges >= 2) return "chaos" as const;
  return "fights" as const;
};

export const updateStoryOnRoll = async (args: {
  roomId: string;
  roomPlayerId: string;
  rank: RankContext;
  context: DiceContext;
}): Promise<StorySnapshot> => {
  const { roomId, roomPlayerId, rank, context } = args;
  const state = await engagementStateCache.getRoomDirectorState(roomId);
  const previousPhase = state.phase;
  state.totalRolls += 1;
  state.updatedAt = Date.now();

  if (rank.isLeader && state.leaderRoomPlayerId !== roomPlayerId) {
    if (state.leaderRoomPlayerId) state.leaderChanges += 1;
    state.leaderRoomPlayerId = roomPlayerId;
  }
  if (!rank.isLeader && (context.leaderKillFaces.size > 0 || context.escapeFaces.size > 0)) {
    state.comebackPulses = Math.min(20, state.comebackPulses + 1);
  } else {
    state.comebackPulses = Math.max(0, state.comebackPulses - 1);
  }

  state.phase = decidePhase({
    totalRolls: state.totalRolls,
    captureCount: state.captureCount,
    leaderChanges: state.leaderChanges,
    comebackPulses: state.comebackPulses,
    rank,
  });

  if (STORY_DIRECTOR_DEBUG && state.phase !== previousPhase) {
    console.log("[story-director] phase-transition", {
      roomId,
      atRoll: state.totalRolls,
      from: previousPhase,
      to: state.phase,
      captureCount: state.captureCount,
      leaderChanges: state.leaderChanges,
      comebackPulses: state.comebackPulses,
      actorRoomPlayerId: roomPlayerId,
      rank: {
        isLeader: rank.isLeader,
        isLast: rank.isLast,
        behindGap: rank.behindGap,
        closeChase: rank.closeChase,
        anyPlayerNearWin: rank.anyPlayerNearWin,
      },
      context: {
        leaderKillFaces: Array.from(context.leaderKillFaces),
        leaderPressureFaces: Array.from(context.leaderPressureFaces),
        escapeFaces: Array.from(context.escapeFaces),
      },
    });
  } else if (STORY_DIRECTOR_DEBUG && state.totalRolls % 12 === 0) {
    console.log("[story-director] snapshot", {
      roomId,
      phase: state.phase,
      totalRolls: state.totalRolls,
      captureCount: state.captureCount,
      leaderChanges: state.leaderChanges,
      comebackPulses: state.comebackPulses,
    });
  }

  await engagementStateCache.setRoomDirectorState(roomId, state);
  return {
    phase: state.phase,
    totalRolls: state.totalRolls,
    captureCount: state.captureCount,
    leaderChanges: state.leaderChanges,
    comebackPulses: state.comebackPulses,
  };
};

export const updateStoryOnCapture = async (roomId: string, captureCount: number) => {
  if (captureCount <= 0) return;
  const state = await engagementStateCache.getRoomDirectorState(roomId);
  state.captureCount += captureCount;
  state.updatedAt = Date.now();
  if (STORY_DIRECTOR_DEBUG) {
    console.log("[story-director] capture", {
      roomId,
      added: captureCount,
      totalCaptures: state.captureCount,
      phase: state.phase,
      totalRolls: state.totalRolls,
    });
  }
  await engagementStateCache.setRoomDirectorState(roomId, state);
};
