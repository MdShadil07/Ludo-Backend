import { TAUNT_LINES } from "./tauntCatalog";
import { mapEventToEmotions } from "./emotionMapper";
import { TauntEventInput, TauntLine, TauntRoomSnapshot, TauntSuggestionItem } from "./types";
import { tauntStateCache } from "./tauntStateCache";

export type RankedPlayer = {
  roomPlayerId: string;
  userId: string;
  rank: number;
  score: number;
};

export const computePhase = (room: TauntRoomSnapshot): "early" | "mid" | "late" => {
  const totalPlayers = Math.max(2, room.players.length);
  const winners = room.board.winners.length;
  if (winners >= Math.max(1, totalPlayers - 2)) return "late";

  const tokenStats = room.players.map((p) => {
    const tokens = room.board.tokens[p.color] || [];
    const out = tokens.filter((t) => t.status !== "base").length;
    const finished = tokens.filter((t) => t.status === "home" || t.status === "finished").length;
    return out + finished;
  });
  const avgProgress = tokenStats.reduce((a, b) => a + b, 0) / Math.max(1, tokenStats.length);
  if (avgProgress < 1.6) return "early";
  if (avgProgress < 3.0) return "mid";
  return "late";
};

const progressScoreForColor = (tokens: TauntRoomSnapshot["board"]["tokens"][keyof TauntRoomSnapshot["board"]["tokens"]] = []) => {
  return (tokens || []).reduce((sum, token) => {
    if (token.status === "base") return sum;
    if (token.status === "home" || token.status === "finished") return sum + 66;
    return sum + Math.max(0, Number(token.steps || 0));
  }, 0);
};

export const computeRanking = (room: TauntRoomSnapshot): RankedPlayer[] => {
  const winnerMap = new Map<string, number>();
  room.board.winners.forEach((entry) => winnerMap.set(String(entry.playerId), Number(entry.rank)));

  const ranked = room.players.map((p) => ({
    roomPlayerId: p.roomPlayerId,
    userId: p.userId,
    score: progressScoreForColor(room.board.tokens[p.color] || []),
    rank: winnerMap.get(p.roomPlayerId) || 999,
  }));

  const nonWinners = ranked
    .filter((p) => p.rank === 999)
    .sort((a, b) => b.score - a.score);

  const winners = ranked
    .filter((p) => p.rank !== 999)
    .sort((a, b) => a.rank - b.rank);

  let nextRank = winners.length + 1;
  nonWinners.forEach((p) => {
    p.rank = nextRank;
    nextRank += 1;
  });

  return [...winners, ...nonWinners].sort((a, b) => a.rank - b.rank);
};

const randomPickWeighted = (candidates: Array<{ line: TauntLine; score: number }>): TauntLine | null => {
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, c) => sum + Math.max(0.0001, c.score), 0);
  const roll = Math.random() * total;
  let cursor = 0;
  for (const candidate of candidates) {
    cursor += Math.max(0.0001, candidate.score);
    if (roll <= cursor) return candidate.line;
  }
  return candidates[candidates.length - 1].line;
};

export const selectSuggestions = async (
  room: TauntRoomSnapshot,
  event: TauntEventInput,
  now: number
): Promise<TauntSuggestionItem[]> => {
  const state = await tauntStateCache.getRoomState(room.roomId);
  tauntStateCache.prune(state, now);

  const actor = tauntStateCache.getPlayerState(state, event.actorRoomPlayerId);
  const emotions = mapEventToEmotions(event);
  const phase = computePhase(room);

  const ranked = TAUNT_LINES
    .filter((line) => line.triggers.includes(event.trigger))
    .filter((line) => emotions.includes(line.category))
    .map((line) => {
      let score = line.weight;
      if (actor.lastLineId && actor.lastLineId === line.id) score *= 0.25;
      if (actor.recentLineIds.includes(line.id)) score *= 0.6;
      if (phase === "late" && (line.category === "clutch" || line.category === "pressure")) score *= 1.15;
      if (event.metadata?.actorWasLast === true && line.category === "comeback") score *= 1.2;
      if (event.metadata?.revengeActive === true && line.category === "revenge") score *= 1.35;
      return { line, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected: TauntSuggestionItem[] = [];
  const used = new Set<string>();
  while (selected.length < 3 && ranked.length > 0) {
    const top = ranked.filter((item) => !used.has(item.line.id)).slice(0, 7);
    const picked = randomPickWeighted(top);
    if (!picked || used.has(picked.id)) break;
    used.add(picked.id);
    selected.push({
      id: picked.id,
      category: picked.category,
      text_en: picked.text_en,
      text_hi: picked.text_hi,
    });
  }

  return selected;
};

