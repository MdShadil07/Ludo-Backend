import { GameConfig, PLAYER_COLOR_MAPS, PlayerColor, Token } from "../../config/ludoConfigBackend";
import { RuntimeRoomState } from "../../state/gameStateCache";
import { DEFAULT_ENGAGEMENT_TUNING, clamp } from "./tuning";

export type RankContext = {
  isLeader: boolean;
  isLast: boolean;
  leadGap: number;
  behindGap: number;
  behindRatio: number;
  anyPlayerNearWin: boolean;
  closeChase: boolean;
  matchPhase: "early" | "mid" | "late";
  spreadScore: number;
  spreadHigh: boolean;
  selfNearWin: boolean;
  behindPlayerCount: number;
};

const tokenProgressScore = (token: Token): number => {
  if (token.status === "home") return 95;
  const outOfBase = token.status === "base" ? 0 : 1;
  const finalStretch = token.position >= 52 ? 1 : 0;
  const steps = Math.max(0, token.steps);
  return outOfBase * 30 + finalStretch * 14 + steps;
};

const remainingCells = (token: Token): number => {
  if (token.status === "home") return 0;
  return Math.max(0, 57 - Math.max(0, token.steps));
};

const scoreGroup = (tokensByColor: Record<PlayerColor, Token[]>, colors: PlayerColor[]) =>
  colors.reduce((acc, color) => {
    const tokens = tokensByColor[color] || [];
    return acc + tokens.reduce((sum, token) => sum + tokenProgressScore(token), 0);
  }, 0);

const remainingGroup = (tokensByColor: Record<PlayerColor, Token[]>, colors: PlayerColor[]) => {
  const values = colors.flatMap((color) => (tokensByColor[color] || []).map(remainingCells));
  if (!values.length) return 0;
  return Math.min(...values);
};

const stdDeviation = (values: number[]): number => {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const buildGroups = (
  activeColors: PlayerColor[],
  controlledColors: PlayerColor[],
  playerCount: number
): PlayerColor[][] => {
  if (controlledColors.length <= 1) {
    return activeColors.map((color) => [color]);
  }

  const ordered = PLAYER_COLOR_MAPS[playerCount] || activeColors;
  const idx = new Map(ordered.map((color, i) => [color, i]));
  const visited = new Set<PlayerColor>();
  const groups: PlayerColor[][] = [];
  const half = Math.floor(playerCount / 2);

  for (const color of activeColors) {
    if (visited.has(color)) continue;
    const i = idx.get(color);
    if (i === undefined || half < 1) {
      visited.add(color);
      groups.push([color]);
      continue;
    }
    const partner = ordered[(i + half) % playerCount];
    if (partner && activeColors.includes(partner)) {
      visited.add(color);
      visited.add(partner);
      groups.push([color, partner]);
      continue;
    }
    visited.add(color);
    groups.push([color]);
  }

  return groups;
};

export const calculateRankContext = (
  state: RuntimeRoomState,
  gameConfig: GameConfig,
  controllableColors: PlayerColor[]
): RankContext => {
  const tokensByColor = state.gameBoard.tokens as Record<PlayerColor, Token[]>;
  const activeColors = gameConfig.players.map((player) => player.id);
  const groups = buildGroups(activeColors, controllableColors, activeColors.length);
  const currentSet = new Set(controllableColors);
  const currentGroup =
    groups.find((group) => group.every((color) => currentSet.has(color)) && group.length === currentSet.size) ||
    [controllableColors[0]];

  const scores = groups.map((group) => scoreGroup(tokensByColor, group));
  const currentScore = scoreGroup(tokensByColor, currentGroup);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const behindPlayerCount = scores.filter((score) => score < maxScore).length;

  const leadGap = Math.max(0, currentScore - minScore);
  const behindGap = Math.max(0, maxScore - currentScore);
  const behindRatio = clamp(behindGap / Math.max(1, maxScore), 0, 1);

  const nearWinThreshold = DEFAULT_ENGAGEMENT_TUNING.endgame.nearWinCells;
  const anyPlayerNearWin = groups.some(
    (group) => remainingGroup(tokensByColor, group) <= nearWinThreshold
  );
  const selfRemaining = remainingGroup(tokensByColor, currentGroup);
  const selfNearWin = selfRemaining <= nearWinThreshold;

  const totalTokens = activeColors.reduce((acc, color) => acc + (tokensByColor[color] || []).length, 0);
  const homeTokens = activeColors.reduce(
    (acc, color) => acc + (tokensByColor[color] || []).filter((token) => token.status === "home").length,
    0
  );
  const homeRatio = totalTokens > 0 ? homeTokens / totalTokens : 0;
  const matchPhase: "early" | "mid" | "late" =
    homeRatio < 0.12 ? "early" : homeRatio < 0.55 ? "mid" : "late";

  const selfSteps = currentGroup.flatMap((color) =>
    (tokensByColor[color] || [])
      .filter((token) => token.status !== "base" && token.status !== "home")
      .map((token) => Math.max(0, token.steps))
  );
  const spreadScore = stdDeviation(selfSteps);
  const spreadHigh = spreadScore >= DEFAULT_ENGAGEMENT_TUNING.spreadAwareness.spreadThreshold;

  return {
    isLeader: currentScore >= maxScore,
    isLast: currentScore <= minScore,
    leadGap,
    behindGap,
    behindRatio,
    anyPlayerNearWin,
    closeChase: behindGap > 0 && behindGap <= DEFAULT_ENGAGEMENT_TUNING.drama.closeChaseGap,
    matchPhase,
    spreadScore,
    spreadHigh,
    selfNearWin,
    behindPlayerCount,
  };
};
