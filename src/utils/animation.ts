import { EventEnvelope } from "../domain/types.js";

export function shouldMarkAnimationComplete(events: EventEnvelope[]): boolean {
  if (events.length === 0) {
    return false;
  }

  const latest = [...events].sort((a, b) => b.seq - a.seq)[0];
  return latest.status === "completed" || latest.status === "failed" || latest.status === "cancelled";
}
