type PlayerStreakState = {
  updatedAt: number;
  recentRolls: number[];
  noMoveStreak: number;
};

type StreakSnapshot = {
  recentRolls: number[];
  noMoveStreak: number;
  repeatedValue: number | null;
  repeatCount: number;
};

const MAX_RECENT_ROLLS = 8;
const STREAK_TTL_MS = 2 * 60 * 60 * 1000;

const playerStreaks = new Map<string, PlayerStreakState>();

const keyOf = (roomId: string, playerId: string) => `${roomId}:${playerId}`;

const purgeExpired = () => {
  const now = Date.now();
  for (const [key, value] of playerStreaks.entries()) {
    if (now - value.updatedAt > STREAK_TTL_MS) {
      playerStreaks.delete(key);
    }
  }
};

const computeRepeat = (recentRolls: number[]): { repeatedValue: number | null; repeatCount: number } => {
  if (!recentRolls.length) return { repeatedValue: null, repeatCount: 0 };
  const last = recentRolls[recentRolls.length - 1];
  let count = 0;
  for (let i = recentRolls.length - 1; i >= 0; i--) {
    if (recentRolls[i] !== last) break;
    count++;
  }
  return { repeatedValue: last, repeatCount: count };
};

export const getStreakSnapshot = (roomId: string, playerId: string): StreakSnapshot => {
  purgeExpired();
  const key = keyOf(roomId, playerId);
  const current = playerStreaks.get(key);
  if (!current) {
    return { recentRolls: [], noMoveStreak: 0, repeatedValue: null, repeatCount: 0 };
  }
  const repeat = computeRepeat(current.recentRolls);
  return {
    recentRolls: [...current.recentRolls],
    noMoveStreak: current.noMoveStreak,
    ...repeat,
  };
};

export const recordRollOutcome = (
  roomId: string,
  playerId: string,
  rolledValue: number,
  hadValidMove: boolean
) => {
  purgeExpired();
  const key = keyOf(roomId, playerId);
  const current = playerStreaks.get(key) || {
    updatedAt: Date.now(),
    recentRolls: [],
    noMoveStreak: 0,
  };

  current.recentRolls.push(rolledValue);
  if (current.recentRolls.length > MAX_RECENT_ROLLS) {
    current.recentRolls.splice(0, current.recentRolls.length - MAX_RECENT_ROLLS);
  }
  current.noMoveStreak = hadValidMove ? 0 : current.noMoveStreak + 1;
  current.updatedAt = Date.now();

  playerStreaks.set(key, current);
};

