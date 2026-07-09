/**
 * Balance harness: scripts the tower a competent first-session player would
 * build (wide lobby, 8 office floors, one well-placed elevator, a fast food),
 * runs a month of sim, and asserts the experience the game promises:
 *
 *   - offices actually lease up within the first days (no dead tower);
 *   - the tower turns a profit well within the month (building is worth it);
 *   - elevator service keeps satisfaction healthy and give-ups rare
 *     (the transport core copes with its own traffic);
 *   - population crosses the 2-star threshold (progression moves).
 *
 * If tuning ever regresses into "nothing happens" or "everyone is furious",
 * this fails before a player ever sees it.
 */
import { describe, expect, it } from 'vitest';
import { applyCommand, tick, type Command } from '../src/core/engine';
import { MINUTES_PER_DAY } from '../src/core/constants';
import { BALANCE, STAR_THRESHOLDS } from '../src/core/rooms/catalog';
import { createInitialState, type TowerState } from '../src/core/state';

function build(state: TowerState, cmds: Command[]): void {
  for (const cmd of cmds) {
    const r = applyCommand(state, cmd);
    if (!r.ok) throw new Error(`harness command rejected (${r.reason}): ${JSON.stringify(cmd)}`);
  }
}

function starterTower(seed: number): TowerState {
  const s = createInitialState(seed, BALANCE.startingMoney);
  const cmds: Command[] = [
    { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 },
    { kind: 'PlaceRoom', type: 'lobby', x: 44, y: 0 },
    { kind: 'PlaceRoom', type: 'lobby', x: 48, y: 0 },
    { kind: 'PlaceRoom', type: 'lobby', x: 52, y: 0 },
    { kind: 'PlaceFloor', y: 0, x0: 56, x1: 70 },
  ];
  for (let y = 1; y <= 8; y++) cmds.push({ kind: 'PlaceFloor', y, x0: 40, x1: 70 });
  for (let y = 1; y <= 8; y++) {
    cmds.push({ kind: 'PlaceRoom', type: 'office', x: 40, y });
    cmds.push({ kind: 'PlaceRoom', type: 'office', x: 46, y });
  }
  cmds.push({ kind: 'PlaceRoom', type: 'fastfood', x: 62, y: 1 });
  cmds.push({ kind: 'PlaceElevator', x: 56, yMin: 0, yMax: 8 });
  build(s, cmds);
  const shaft = s.transports.find((t) => t.type === 'elevator')!;
  const r = applyCommand(s, { kind: 'AddElevatorCar', transportId: shaft.id });
  if (!r.ok) throw new Error(r.reason);
  return s;
}

describe('a competent starter tower over 30 days', () => {
  it('leases up, profits, keeps people moving and reaches 2 stars', () => {
    const s = starterTower(20260709);
    const moneyAfterBuild = s.money;

    let totalTrips = 0;
    let totalGiveUps = 0;
    let moneyAtDay15 = 0;
    const days = 30;
    for (let i = 0; i < days * MINUTES_PER_DAY; i++) {
      tick(s);
      // Sample daily stats just before the midnight reset.
      if (s.minutes % MINUTES_PER_DAY === MINUTES_PER_DAY - 1) {
        totalTrips += s.dailyStats.trips;
        totalGiveUps += s.dailyStats.giveUps;
      }
      if (Math.floor(s.minutes / MINUTES_PER_DAY) === 15 && moneyAtDay15 === 0) {
        moneyAtDay15 = s.money;
      }
    }

    const offices = s.rooms.filter((r) => r.type === 'office');
    const leased = offices.filter((r) => r.occupied);
    expect(leased.length).toBeGreaterThanOrEqual(Math.ceil(offices.length * 0.6));

    // The tower must be comfortably profitable within the month.
    expect(s.money).toBeGreaterThan(moneyAfterBuild + 20_000);
    // ...and still growing in the second half.
    expect(s.money).toBeGreaterThan(moneyAtDay15);

    // Transport copes: satisfaction healthy, give-ups a rounding error.
    const avgSat =
      leased.reduce((sum, r) => sum + r.satisfaction, 0) / Math.max(1, leased.length);
    expect(avgSat).toBeGreaterThanOrEqual(55);
    expect(totalTrips).toBeGreaterThan(500);
    expect(totalGiveUps).toBeLessThan(totalTrips * 0.03);

    // Progression: past the 2-star population threshold.
    expect(s.population).toBeGreaterThanOrEqual(STAR_THRESHOLDS[1]!);
    expect(s.stars.rating).toBeGreaterThanOrEqual(2);
  });
});
