import { TauntCategory, TauntEventInput } from "./types";

const mapByTrigger: Record<string, TauntCategory[]> = {
  rolled_six: ["pressure", "appreciation"],
  released_token: ["comeback", "appreciation"],
  captured: ["dominance", "pressure"],
  got_captured: ["panic_reaction", "comeback"],
  narrow_escape: ["mock_escape", "pressure"],
  entered_safe: ["mock_escape"],
  near_win: ["clutch", "pressure"],
  lead_change: ["dominance", "pressure"],
  last_place: ["comeback", "panic_reaction"],
  revenge_kill: ["revenge", "clutch"],
  clutch_roll: ["clutch", "pressure"],
  blocked_opponent: ["dominance", "pressure"],
};

export const mapEventToEmotions = (event: TauntEventInput): TauntCategory[] => {
  const base = mapByTrigger[event.trigger] || ["pressure"];
  const meta = event.metadata || {};
  const categories = [...base];

  if (meta.revengeActive === true && !categories.includes("revenge")) {
    categories.unshift("revenge");
  }
  if (meta.actorWasLast === true && !categories.includes("comeback")) {
    categories.unshift("comeback");
  }
  if (meta.targetWasLeader === true && !categories.includes("clutch")) {
    categories.unshift("clutch");
  }

  return Array.from(new Set(categories));
};

