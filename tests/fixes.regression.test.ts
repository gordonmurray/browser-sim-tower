/**
 * Regression tests for the review findings fixed in this pass:
 *   1. Elevator livelock: a car must not pin at a floor whose only hall call
 *      it cannot board (opposite direction / full car).
 *   2. Hotel booking revert race: a co-guest giving up must not brick the room.
 *   3. Save import: an envelope without a valid state payload throws SaveError.
 *   4. Reachability honours the stair cap that trip planning enforces.
 *   5. Elevator placement auto-builds landings through existing construction.
 *   6. Floor drags place their buildable cells instead of failing outright.
 */
import { describe, expect, it } from 'vitest';
import { applyCommand, type Command } from '../src/core/engine';
import { GIVE_UP_WAIT_MINUTES } from '../src/core/constants';
import { BALANCE, ROOM_CATALOG } from '../src/core/rooms/catalog';
import { allocId, createInitialState, type Person, type TowerState } from '../src/core/state';
import { clockOf } from '../src/core/sim/time';
import { tenantsStep } from '../src/core/sim/tenants';
import { transportStep } from '../src/core/sim/transport';
import { SaveError } from '../src/save/migrations';
import { deserialize } from '../src/save/storage';

function issueOk(state: TowerState, cmd: Command): void {
  const r = applyCommand(state, cmd);
  if (!r.ok) throw new Error(`fixture command rejected (${r.reason}): ${JSON.stringify(cmd)}`);
}

/** Lobby + ground strip + full floors 1..top + one elevator serving 0..top. */
function elevatorTower(top: number): TowerState {
  const s = createInitialState(1, 10_000_000);
  issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 });
  issueOk(s, { kind: 'PlaceFloor', y: 0, x0: 44, x1: 52 });
  for (let y = 1; y <= top; y++) issueOk(s, { kind: 'PlaceFloor', y, x0: 40, x1: 52 });
  issueOk(s, { kind: 'PlaceElevator', x: 44, yMin: 0, yMax: top });
  return s;
}

function shaftOf(s: TowerState) {
  return s.transports.find((t) => t.type === 'elevator')!;
}

function mkPerson(s: TowerState, over: Partial<Person>): Person {
  const p: Person = {
    id: allocId(s),
    kind: 'worker',
    homeRoomId: null,
    targetRoomId: null,
    floor: 0,
    x: 45,
    targetX: 45,
    legs: [],
    legIndex: 0,
    phase: { kind: 'walking', minutesLeft: 0 },
    dwellMinutes: 0,
    returnTo: null,
    totalWait: 0,
    ...over,
  };
  s.people.push(p);
  return p;
}

describe('elevator livelock (critical review findings)', () => {
  it('a rider is delivered promptly past an opposite-direction hall call', () => {
    const s = elevatorTower(8);
    const shaft = shaftOf(s);
    shaft.cars = [shaft.cars![0]!]; // single car for a deterministic trace
    const car = shaft.cars[0]!;

    const rider = mkPerson(s, {
      floor: 0,
      phase: { kind: 'riding', transportId: shaft.id, carId: car.id, toFloor: 7 },
      legs: [{ kind: 'elevator', transportId: shaft.id, fromFloor: 0, toFloor: 7 }],
    });
    car.passengerIds = [rider.id];
    car.dir = 1;
    // The trap: a waiter at floor 3 who wants to go DOWN.
    const waiter = mkPerson(s, {
      floor: 3,
      phase: { kind: 'waitingElevator', transportId: shaft.id, toFloor: 0, waitedMin: 0 },
      legs: [{ kind: 'elevator', transportId: shaft.id, fromFloor: 3, toFloor: 0 }],
    });

    let deliveredAt = -1;
    for (let i = 1; i <= 60; i++) {
      transportStep(s);
      if (deliveredAt < 0 && rider.phase.kind !== 'riding') deliveredAt = i;
    }
    // Old behaviour: the car pinned at floor 3 for GIVE_UP_WAIT_MINUTES.
    expect(deliveredAt).toBeGreaterThan(0);
    expect(deliveredAt).toBeLessThan(15);
    // The down-waiter is picked up on the way back, well before giving up.
    expect(s.dailyStats.giveUps).toBe(0);
    const stillWaiting = s.people.find((p) => p.id === waiter.id);
    if (stillWaiting && stillWaiting.phase.kind === 'waitingElevator') {
      expect(stillWaiting.phase.waitedMin).toBeLessThan(GIVE_UP_WAIT_MINUTES);
    }
  });

  it('a full car departs past extra waiters and returns for them', () => {
    const s = elevatorTower(5);
    const shaft = shaftOf(s);
    shaft.cars = [shaft.cars![0]!];
    for (let i = 0; i < 16; i++) {
      mkPerson(s, {
        floor: 0,
        phase: { kind: 'waitingElevator', transportId: shaft.id, toFloor: 5, waitedMin: i },
        legs: [{ kind: 'elevator', transportId: shaft.id, fromFloor: 0, toFloor: 5 }],
      });
    }
    for (let i = 1; i <= 150; i++) transportStep(s);
    // Everyone delivered (arrivals despawn); nobody gave up; no pinned car.
    expect(s.people.length).toBe(0);
    expect(s.dailyStats.giveUps).toBe(0);
  });
});

describe('hotel booking revert race (major review finding)', () => {
  it('a co-guest giving up does not brick the room; checkout settles it', () => {
    const s = elevatorTower(3);
    s.stars.rating = 2;
    issueOk(s, { kind: 'PlaceRoom', type: 'hotelDouble', x: 47, y: 2 });
    const room = s.rooms.find((r) => r.type === 'hotelDouble')!;
    const shaft = shaftOf(s);
    shaft.cars = [shaft.cars![0]!];
    const car = shaft.cars[0]!;

    room.occupied = true; // booked, two guests inbound
    const guestA = mkPerson(s, {
      kind: 'guest',
      homeRoomId: room.id,
      targetRoomId: room.id,
      floor: 0,
      phase: { kind: 'riding', transportId: shaft.id, carId: car.id, toFloor: 2 },
      legs: [{ kind: 'elevator', transportId: shaft.id, fromFloor: 0, toFloor: 2 }],
    });
    car.passengerIds = [guestA.id];
    car.dir = 1;
    // Guest B gives up on the next waiting tick while A is still riding.
    mkPerson(s, {
      kind: 'guest',
      homeRoomId: room.id,
      targetRoomId: room.id,
      floor: 0,
      phase: {
        kind: 'waitingElevator',
        transportId: shaft.id,
        toFloor: 2,
        waitedMin: GIVE_UP_WAIT_MINUTES - 1,
      },
      legs: [{ kind: 'elevator', transportId: shaft.id, fromFloor: 0, toFloor: 2 }],
    });

    for (let i = 0; i < 40; i++) transportStep(s);
    // A arrived; the booking must have survived B's give-up.
    expect(room.occupants).toBe(1);
    expect(room.occupied).toBe(true);
    expect(room.hotel!.state).toBe('occupied');

    // Checkout at 08:00 settles the night: income lands, room turns dirty.
    const moneyBefore = s.money;
    const checkoutMinutes = BALANCE.hotelCheckOutHour * 60;
    tenantsStep(s, clockOf(checkoutMinutes), []);
    expect(room.occupants).toBe(0);
    expect(room.occupied).toBe(false);
    expect(room.hotel!.state).toBe('dirty');
    expect(s.money).toBe(moneyBefore + (ROOM_CATALOG.hotelDouble.nightlyRate ?? 0));
    expect(s.ledger.some((e) => e.label === 'Hotel nights')).toBe(true);
  });
});

describe('save payload validation (major review finding)', () => {
  it('rejects a JSON-valid envelope whose state is missing or garbage', () => {
    expect(() => deserialize('{"saveVersion":1,"savedAt":0}')).toThrow(SaveError);
    expect(() => deserialize('{"saveVersion":1,"savedAt":0,"state":null}')).toThrow(SaveError);
    expect(() => deserialize('{"saveVersion":1,"savedAt":0,"state":{"minutes":5}}')).toThrow(
      SaveError,
    );
  });
});

describe('reachability honours the stair cap (review finding)', () => {
  it('a stairs-only room above MAX_STAIR_FLOORS flights is unreachable until an elevator serves it', () => {
    const s = createInitialState(3, 10_000_000);
    issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 });
    issueOk(s, { kind: 'PlaceFloor', y: 0, x0: 44, x1: 70 });
    for (let y = 1; y <= 5; y++) issueOk(s, { kind: 'PlaceFloor', y, x0: 40, x1: 70 });
    issueOk(s, { kind: 'PlaceStairs', x: 44, y: 0 });
    issueOk(s, { kind: 'PlaceStairs', x: 47, y: 1 });
    issueOk(s, { kind: 'PlaceStairs', x: 50, y: 2 });
    issueOk(s, { kind: 'PlaceStairs', x: 44, y: 3 });
    issueOk(s, { kind: 'PlaceStairs', x: 47, y: 4 }); // 5 flights to floor 5
    issueOk(s, { kind: 'PlaceRoom', type: 'office', x: 60, y: 4 });
    issueOk(s, { kind: 'PlaceRoom', type: 'office', x: 60, y: 5 });

    const office4 = s.rooms.find((r) => r.type === 'office' && r.y === 4)!;
    const office5 = s.rooms.find((r) => r.type === 'office' && r.y === 5)!;
    expect(office4.reachable).toBe(true); // 4 flights: exactly at the cap
    expect(office5.reachable).toBe(false); // 5 flights: nobody will climb this

    issueOk(s, { kind: 'PlaceElevator', x: 67, yMin: 0, yMax: 5 });
    expect(office5.reachable).toBe(true);
  });
});

describe('elevator landings auto-build (baseline playability trap)', () => {
  it('a shaft placed beside self-built rooms serves their floors', () => {
    const s = createInitialState(4, 10_000_000);
    issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 });
    issueOk(s, { kind: 'PlaceFloor', y: 0, x0: 44, x1: 49 });
    // Rooms auto-build ONLY their own cells (x40..45) on floors 1..3.
    for (let y = 1; y <= 3; y++) issueOk(s, { kind: 'PlaceRoom', type: 'office', x: 40, y });
    // The shaft column (x46..48) has ground structure below; the auto-build
    // chains its own landings up through floors 1..3.
    issueOk(s, { kind: 'PlaceElevator', x: 46, yMin: 0, yMax: 3 });
    expect(s.rooms.filter((r) => r.type === 'office').every((r) => r.reachable)).toBe(true);
  });

  it('landing auto-build cells are charged and reported in the cost', () => {
    const s = createInitialState(5, 10_000_000);
    issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 });
    issueOk(s, { kind: 'PlaceFloor', y: 0, x0: 44, x1: 49 });
    for (let y = 1; y <= 3; y++) issueOk(s, { kind: 'PlaceRoom', type: 'office', x: 40, y });
    const before = s.money;
    const r = applyCommand(s, { kind: 'PlaceElevator', x: 46, yMin: 0, yMax: 3 });
    if (!r.ok) throw new Error(r.reason);
    const expected =
      BALANCE.elevatorBaseCost +
      4 * BALANCE.elevatorCostPerFloor +
      BALANCE.elevatorCarsIncluded * BALANCE.elevatorCarCost +
      9 * BALANCE.structureCostPerCell; // 3 cells × floors 1..3 (ground exists)
    expect(r.cost).toBe(expected);
    expect(s.money).toBe(before - expected);
  });
});

describe('partial floor placement (baseline playability trap)', () => {
  it('an over-wide drag builds its supported cells instead of failing', () => {
    const s = createInitialState(6, 10_000_000);
    issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 }); // ground x40..43
    const r = applyCommand(s, { kind: 'PlaceFloor', y: 1, x0: 30, x1: 50 });
    if (!r.ok) throw new Error(r.reason);
    // Supported cells above the lobby (±1 overhang): x39..44.
    expect(r.cost).toBe(6 * BALANCE.structureCostPerCell);
    const floor1 = s.structure.find((f) => f.y === 1)!;
    expect(floor1.runs).toEqual([{ x0: 39, x1: 44 }]);
  });

  it('still fails when nothing in the drag can be built', () => {
    const s = createInitialState(7, 10_000_000);
    issueOk(s, { kind: 'PlaceRoom', type: 'lobby', x: 40, y: 0 });
    const r = applyCommand(s, { kind: 'PlaceFloor', y: 3, x0: 10, x1: 20 });
    expect(r).toEqual({ ok: false, reason: 'no-support' });
  });
});
