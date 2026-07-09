/**
 * Satisfaction: recomputed once per day at midnight. Driven mainly by average
 * elevator wait, plus noise adjacency, support-room coverage, reachability and
 * (at 3★+) recycling coverage. Satisfaction feeds move-outs, hotel bookings
 * and retail demand — the central feedback loop.
 */
import { BALANCE, ROOM_CATALOG } from '../rooms/catalog';
import type { Room, TowerState } from '../state';
import type { Clock } from './time';

function waitScore(avgWait: number): number {
  if (avgWait <= 2) return 95;
  if (avgWait <= 5) return 85;
  if (avgWait <= 10) return 70;
  if (avgWait <= 20) return 50;
  if (avgWait <= 35) return 30;
  return 12;
}

function hasNoisyNeighbour(state: TowerState, room: Room): boolean {
  return state.rooms.some((r) => {
    if (r.id === room.id || !ROOM_CATALOG[r.type].noisy) return false;
    const horizAdjacent = r.y === room.y && (r.x + r.w === room.x || room.x + room.w === r.x);
    const overlapX = r.x < room.x + room.w && room.x < r.x + r.w;
    const vertAdjacent = overlapX && Math.abs(r.y - room.y) === 1;
    return horizAdjacent || vertAdjacent;
  });
}

function supportBonus(state: TowerState, room: Room): number {
  let bonus = 0;
  const near = (type: string) =>
    state.rooms.some(
      (r) => r.type === type && r.reachable && Math.abs(r.y - room.y) <= BALANCE.supportRadius,
    );
  if (near('security')) bonus += BALANCE.supportBonus;
  if (near('medical')) bonus += BALANCE.supportBonus;
  return bonus;
}

function recyclingPenalty(state: TowerState): number {
  if (state.stars.rating < 3) return 0;
  const needed = Math.ceil(state.population / BALANCE.recyclingPopPerCentre);
  const have = state.rooms.filter((r) => r.type === 'recycling' && r.reachable).length;
  return have >= needed ? 0 : BALANCE.recyclingPenalty;
}

const RATED_CATEGORIES = new Set(['office', 'residence', 'hotel', 'retail']);

export function satisfactionStep(state: TowerState, clock: Clock): void {
  if (clock.minuteOfDay !== 0) return;

  const globalPenalty = recyclingPenalty(state);

  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];

    // Fold the day's wait samples into the running average.
    if (room.waitSamples > 0) {
      room.avgWait = room.waitTotal / room.waitSamples;
    } else if (room.avgWait > 0) {
      room.avgWait *= 0.7; // quiet day: old pain fades
    }
    room.waitSamples = 0;
    room.waitTotal = 0;

    // Housekeeping capacity resets daily.
    if (room.type === 'housekeeping') room.cleaningDone = 0;

    if (!RATED_CATEGORIES.has(def.category)) continue;

    if (!room.reachable) {
      room.satisfaction = Math.max(0, room.satisfaction - 8);
      room.noisePenalty = 0;
      continue;
    }

    const noise = def.noiseSensitive && hasNoisyNeighbour(state, room) ? 15 : 0;
    room.noisePenalty = noise;
    const target = Math.max(
      0,
      Math.min(100, waitScore(room.avgWait) - noise + supportBonus(state, room) - globalPenalty),
    );
    const delta = Math.max(-12, Math.min(12, target - room.satisfaction));
    room.satisfaction = Math.max(0, Math.min(100, room.satisfaction + delta * 0.5));
  }

  // New day: reset tower-wide stats.
  state.dailyStats = { trips: 0, totalWait: 0, maxWait: 0, giveUps: 0 };
}
