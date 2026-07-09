/**
 * Simulation property / invariant tests over the pure core.
 *
 * A fixed test tower is built through the command interface (lobby row on the
 * ground floor, floors 1..5, several offices, a condo, one elevator shaft at
 * x=60 spanning floors 0..5, staggered stairs), then the sim is ticked while
 * asserting invariants:
 *
 *   1. Elevator invariants (capacity, shaft range, passenger integrity),
 *      checked at every tick, for a long fixed-seed run and for arbitrary
 *      seeds via fast-check.
 *   2. Determinism: same seed + same commands => byte-identical state
 *      trajectories (JSON.stringify), with the two states ticked interleaved
 *      so the module-level transport-graph cache is stressed.
 *   3. A simulated week of general sanity (clock, population, satisfaction
 *      bounds, people count, finite money).
 *   4. Trip generation: leased offices produce trips on weekday mornings.
 *
 * All seeds are fixed; the core is deterministic, so these tests are too.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyCommand, tick, type Command } from '../src/core/engine';
import { createInitialState, type TowerState } from '../src/core/state';
import { ELEVATOR_CAPACITY, MINUTES_PER_DAY } from '../src/core/constants';
import { BALANCE } from '../src/core/rooms/catalog';
import { clockOf } from '../src/core/sim/time';

// ---------------------------------------------------------------------------
// Fixture tower
// ---------------------------------------------------------------------------

/**
 * Ground floor: lobbies covering x=40..59, bare structure x=60..70 so the
 * elevator shaft (x=60..62, 3 wide) and the stairs get ground landings without
 * overlapping any room (the ground floor only accepts lobby *rooms*, but
 * PlaceFloor structure is allowed).
 * Floors 1..5 span x=40..70. Offices/condo sit at x<=57, clear of the shaft.
 * Stairs are staggered horizontally so their 2-floor footprints never overlap,
 * and only cover floors 0..2: the router's cost model prefers stairs for short
 * hops, so stopping the stairwell at floor 2 guarantees floors 3..5 generate
 * real elevator traffic for the invariant checks.
 */
const TOWER_COMMANDS: readonly Command[] = [
  { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 },
  { kind: 'PlaceRoom', type: 'lobby', x: 44, y: 0 },
  { kind: 'PlaceRoom', type: 'lobby', x: 48, y: 0 },
  { kind: 'PlaceRoom', type: 'lobby', x: 52, y: 0 },
  { kind: 'PlaceRoom', type: 'lobby', x: 56, y: 0 },
  { kind: 'PlaceFloor', y: 0, x0: 60, x1: 70 },
  { kind: 'PlaceFloor', y: 1, x0: 40, x1: 70 },
  { kind: 'PlaceFloor', y: 2, x0: 40, x1: 70 },
  { kind: 'PlaceFloor', y: 3, x0: 40, x1: 70 },
  { kind: 'PlaceFloor', y: 4, x0: 40, x1: 70 },
  { kind: 'PlaceFloor', y: 5, x0: 40, x1: 70 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 1 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 1 },
  { kind: 'PlaceRoom', type: 'office', x: 52, y: 1 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 2 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 2 },
  { kind: 'PlaceRoom', type: 'condo', x: 40, y: 3 },
  { kind: 'PlaceRoom', type: 'office', x: 48, y: 3 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 4 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 4 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 5 },
  { kind: 'PlaceElevator', x: 60, yMin: 0, yMax: 5 },
  { kind: 'PlaceStairs', x: 64, y: 0 },
  { kind: 'PlaceStairs', x: 67, y: 1 },
];

function buildTower(seed: number): TowerState {
  const state = createInitialState(seed, BALANCE.startingMoney);
  for (const cmd of TOWER_COMMANDS) {
    const result = applyCommand(state, cmd);
    if (!result.ok) {
      throw new Error(`fixture command rejected (${result.reason}): ${JSON.stringify(cmd)}`);
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Invariant checkers (plain JS in the hot loop; throw with context on failure)
// ---------------------------------------------------------------------------

/** Returns a description of the first violated elevator invariant, or null. */
function elevatorViolation(state: TowerState): string | null {
  for (const shaft of state.transports) {
    if (shaft.type !== 'elevator' || !shaft.cars) continue;
    for (const car of shaft.cars) {
      const n = car.passengerIds.length;
      if (n < 0 || n > ELEVATOR_CAPACITY) {
        return `car ${car.id}: ${n} passengers exceeds capacity ${ELEVATOR_CAPACITY}`;
      }
      if (!(car.y >= shaft.yMin && car.y <= shaft.yMax)) {
        return `car ${car.id}: y=${car.y} outside shaft range [${shaft.yMin}, ${shaft.yMax}]`;
      }
      for (const pid of car.passengerIds) {
        const person = state.people.find((p) => p.id === pid);
        if (!person) {
          return `car ${car.id}: passengerId ${pid} has no matching person in state.people`;
        }
        if (person.phase.kind !== 'riding') {
          return `car ${car.id}: passenger ${pid} phase is '${person.phase.kind}', expected 'riding'`;
        }
        if (person.phase.carId !== car.id || person.phase.transportId !== shaft.id) {
          return `car ${car.id}: passenger ${pid} claims to ride car ${person.phase.carId} on shaft ${person.phase.transportId}`;
        }
      }
    }
  }
  return null;
}

function anyRiderPresent(state: TowerState): boolean {
  return state.transports.some(
    (t) => t.type === 'elevator' && (t.cars ?? []).some((c) => c.passengerIds.length > 0),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fixture tower', () => {
  it('builds cleanly via commands and every room is reachable', () => {
    const state = buildTower(1);
    expect(state.rooms).toHaveLength(15); // 5 lobbies + 9 offices + 1 condo
    expect(state.transports).toHaveLength(3); // 1 elevator + 2 stairs
    expect(state.rooms.every((r) => r.reachable)).toBe(true);
    expect(state.money).toBeGreaterThan(0);
    const shaft = state.transports.find((t) => t.type === 'elevator');
    expect(shaft).toBeDefined();
    expect(shaft!.cars).toHaveLength(BALANCE.elevatorCarsIncluded);
  });
});

describe('elevator invariants', () => {
  it('capacity, shaft range and passenger integrity hold at every tick for 6000 ticks', () => {
    const state = buildTower(20260706);
    let sawRider = false;
    for (let i = 1; i <= 6000; i++) {
      tick(state);
      const violation = elevatorViolation(state);
      if (violation !== null) {
        throw new Error(`tick ${i} (sim minute ${state.minutes}): ${violation}`);
      }
      if (!sawRider && anyRiderPresent(state)) sawRider = true;
    }
    expect(elevatorViolation(state)).toBeNull();
    // The invariant run must actually exercise elevators: over ~4 days offices
    // lease and commuters ride to floors 2..5.
    expect(sawRider).toBe(true);
  });

  it('hold for arbitrary RNG seeds (fast-check property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7fffffff }), (seed) => {
        const state = buildTower(seed);
        // 1200 ticks: through the first midnight lease roll and the following
        // weekday morning rush.
        for (let i = 1; i <= 1200; i++) {
          tick(state);
          const violation = elevatorViolation(state);
          if (violation !== null) {
            throw new Error(`seed ${seed}, tick ${i}: ${violation}`);
          }
        }
      }),
      { numRuns: 5, seed: 42 },
    );
  });
});

describe('determinism', () => {
  it('same seed + same commands tick identically for 3000 ticks (interleaved)', () => {
    const a = buildTower(1337);
    const b = buildTower(1337);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    // Checkpoints straddle the first two midnights (ticks 1020 and 2460 from
    // the 07:00 start) where lease rolls, satisfaction and economy fire.
    const checkpoints = new Set([1, 100, 500, 1020, 1021, 1500, 2000, 2460, 3000]);
    for (let i = 1; i <= 3000; i++) {
      // Interleaving the two states deliberately thrashes the module-level
      // transport-graph cache (keyed on state identity + structureVersion);
      // caching must not change behaviour.
      tick(a);
      tick(b);
      if (checkpoints.has(i)) {
        const ja = JSON.stringify(a);
        const jb = JSON.stringify(b);
        if (ja !== jb) {
          // Give a targeted diff before failing on the full strings.
          expect(JSON.parse(ja), `state divergence at tick ${i}`).toEqual(JSON.parse(jb));
          expect(ja, `stringify divergence at tick ${i}`).toBe(jb);
        }
      }
    }
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('a simulated week stays sane', () => {
  it('clock, population, satisfaction, people count and money hold for 10080 ticks', () => {
    const state = buildTower(9001);
    const startMinutes = state.minutes;
    for (let i = 1; i <= 10080; i++) {
      tick(state);
      if (state.minutes !== startMinutes + i) {
        throw new Error(`tick ${i}: minutes=${state.minutes}, expected ${startMinutes + i}`);
      }
      if (state.population < 0) {
        throw new Error(`tick ${i}: negative population ${state.population}`);
      }
      if (!Number.isFinite(state.money)) {
        throw new Error(`tick ${i}: money is not finite (${state.money})`);
      }
      if (state.people.length >= 2000) {
        throw new Error(`tick ${i}: ${state.people.length} people (runaway spawning)`);
      }
      for (const room of state.rooms) {
        if (!(room.satisfaction >= 0 && room.satisfaction <= 100)) {
          throw new Error(
            `tick ${i}: room ${room.id} (${room.type}) satisfaction ${room.satisfaction} outside [0,100]`,
          );
        }
      }
    }
    expect(state.minutes).toBe(startMinutes + 10080);
    expect(state.population).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(state.money)).toBe(true);
  });
});

describe('trip generation', () => {
  it('with at least 2 leased offices, dailyStats.trips > 0 during a weekday morning', () => {
    const state = buildTower(777);
    const leasedOffices = () =>
      state.rooms.filter((r) => r.type === 'office' && r.occupied).length;

    // Offices lease at weekday-midnight rolls; tick until at least two are
    // leased and a weekday morning shows traffic. Cap the search generously.
    let observedTrips = 0;
    const maxTicks = 20 * MINUTES_PER_DAY;
    for (let i = 1; i <= maxTicks; i++) {
      tick(state);
      const clock = clockOf(state.minutes);
      if (!clock.isWeekend && clock.hour >= 7 && clock.hour < 12 && leasedOffices() >= 2) {
        observedTrips = Math.max(observedTrips, state.dailyStats.trips);
        if (observedTrips > 0) break;
      }
    }

    expect(leasedOffices()).toBeGreaterThanOrEqual(2);
    expect(observedTrips).toBeGreaterThan(0);
  });
});
