/**
 * Property-based tests over the placement rule system (the placement invariants).
 *
 * Strategy: generate random command sequences (coordinates biased to a small
 * window around x 30..70, floors -3..6 so placements frequently succeed),
 * always seeded with a lobby at (48, 0), and assert after every accepted
 * command that:
 *   1. no two rooms overlap, and no room overlaps a transport footprint;
 *   2. applyCommand() agrees exactly with the rule validators (verdict, reason
 *      and cost) — validation is never bypassed;
 *   3. money never goes negative from construction and moves by exactly the
 *      returned cost of accepted commands;
 *   4. every structure cell is supported (above ground: structure below within
 *      x-1..x+1; basement: structure above within x-1..x+1);
 *   5. star-gated content is rejected with 'star-locked' at 1 star.
 *
 * All fc.assert calls use fixed seeds so runs are deterministic.
 */
import { describe, expect, test } from 'vitest';
import fc from 'fast-check';

import { applyCommand, type Command } from '../src/core/engine';
import { STAIRLIKE_WIDTH } from '../src/core/engine';
import { createInitialState, type RoomTypeId, type TowerState } from '../src/core/state';
import { BALANCE, ROOM_CATALOG } from '../src/core/rooms/catalog';
import {
  validateAddCar,
  validateDemolish,
  validateElevatorPlacement,
  validateExtendElevator,
  validateFloorPlacement,
  validateRoomPlacement,
  validateStairlike,
  type FailureReason,
} from '../src/core/rules/rules';

// ---------------------------------------------------------------------------
// Helpers (deliberately independent re-implementations of the invariants —
// they read raw TowerState instead of trusting src/core/grid queries)
// ---------------------------------------------------------------------------

const LOBBY_CMD: Command = { kind: 'PlaceRoom', type: 'lobby', x: 48, y: 0 };

/** Fresh 1-star tower with the seed lobby at (48, 0) already accepted. */
function freshTower(seed = 42, money = BALANCE.startingMoney): TowerState {
  const state = createInitialState(seed, money);
  const res = applyCommand(state, LOBBY_CMD);
  if (!res.ok) throw new Error(`seed lobby must succeed, got ${res.reason}`);
  return state;
}

function hasStructureCell(state: TowerState, x: number, y: number): boolean {
  const floor = state.structure.find((f) => f.y === y);
  return floor !== undefined && floor.runs.some((r) => x >= r.x0 && x <= r.x1);
}

/**
 * Invariant 4: every above-ground structure cell (y >= 1) has structure on the
 * floor below within x-1..x+1; every basement cell (y <= -1) mirrors that
 * against the floor above. Ground (y = 0) rests on the ground.
 */
function supportViolations(state: TowerState): string[] {
  const out: string[] = [];
  for (const floor of state.structure) {
    if (floor.y === 0) continue;
    const towardGround = floor.y > 0 ? floor.y - 1 : floor.y + 1;
    for (const run of floor.runs) {
      for (let x = run.x0; x <= run.x1; x++) {
        const supported =
          hasStructureCell(state, x - 1, towardGround) ||
          hasStructureCell(state, x, towardGround) ||
          hasStructureCell(state, x + 1, towardGround);
        if (!supported) out.push(`structure cell (${x}, ${floor.y}) is unsupported`);
      }
    }
  }
  return out;
}

/**
 * Invariant 1: no room overlaps another room, and no room overlaps a
 * transport's footprint (x..x+w-1 over yMin..yMax). Transports must not
 * overlap each other either (rectFree forbids both).
 */
function overlapViolations(state: TowerState): string[] {
  const out: string[] = [];
  const rooms = state.rooms;
  const transports = state.transports;
  for (let i = 0; i < rooms.length; i++) {
    const a = rooms[i]!;
    for (let j = i + 1; j < rooms.length; j++) {
      const b = rooms[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
        out.push(`rooms #${a.id} (${a.type}) and #${b.id} (${b.type}) overlap`);
      }
    }
    for (const t of transports) {
      if (a.x < t.x + t.w && t.x < a.x + a.w && a.y <= t.yMax && a.y + a.h - 1 >= t.yMin) {
        out.push(`room #${a.id} (${a.type}) overlaps transport #${t.id} (${t.type})`);
      }
    }
  }
  for (let i = 0; i < transports.length; i++) {
    const a = transports[i]!;
    for (let j = i + 1; j < transports.length; j++) {
      const b = transports[j]!;
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.yMin <= b.yMax && b.yMin <= a.yMax) {
        out.push(`transports #${a.id} (${a.type}) and #${b.id} (${b.type}) overlap`);
      }
    }
  }
  return out;
}

type Expected = { ok: true; cost: number } | { ok: false; reason: FailureReason };

/**
 * Invariant 2 oracle: what the rule validators say about a command against the
 * current state, mirroring the engine's shaft lookup for the by-id commands.
 * Validators are pure, so calling them before applyCommand cannot perturb it.
 */
function expectedVerdict(state: TowerState, cmd: Command): Expected {
  switch (cmd.kind) {
    case 'PlaceRoom':
      return validateRoomPlacement(state, cmd.type, cmd.x, cmd.y);
    case 'PlaceFloor':
      return validateFloorPlacement(state, cmd.y, cmd.x0, cmd.x1);
    case 'PlaceStairs':
      return validateStairlike(state, 'stairs', cmd.x, cmd.y, STAIRLIKE_WIDTH.stairs);
    case 'PlaceEscalator':
      return validateStairlike(state, 'escalator', cmd.x, cmd.y, STAIRLIKE_WIDTH.escalator);
    case 'PlaceElevator':
      return validateElevatorPlacement(state, cmd.x, cmd.yMin, cmd.yMax);
    case 'ExtendElevator': {
      const shaft = state.transports.find((t) => t.id === cmd.transportId);
      if (!shaft) return { ok: false, reason: 'not-an-elevator' };
      return validateExtendElevator(state, shaft, cmd.yMin, cmd.yMax);
    }
    case 'AddElevatorCar': {
      const shaft = state.transports.find((t) => t.id === cmd.transportId);
      if (!shaft) return { ok: false, reason: 'not-an-elevator' };
      return validateAddCar(state, shaft);
    }
    case 'Demolish': {
      const v = validateDemolish(state, cmd.x, cmd.y);
      return v.ok ? { ok: true, cost: v.cost } : { ok: false, reason: v.reason };
    }
    case 'SetSpeed':
      return { ok: true, cost: 0 };
  }
}

// ---------------------------------------------------------------------------
// Command generators (biased to x 30..70, y -3..6 so placements often succeed)
// ---------------------------------------------------------------------------

const ROOM_TYPES = Object.keys(ROOM_CATALOG) as RoomTypeId[];

const xArb = fc.integer({ min: 30, max: 70 });
const yArb = fc.integer({ min: -3, max: 6 });
/** Ids are allocated sequentially from 1, so small ids often hit real shafts. */
const idArb = fc.integer({ min: 1, max: 40 });

const placeRoomArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('PlaceRoom' as const),
  type: fc.constantFrom(...ROOM_TYPES),
  x: xArb,
  y: yArb,
});

const placeFloorArb: fc.Arbitrary<Command> = fc
  .tuple(yArb, xArb, fc.integer({ min: -2, max: 12 }))
  .map(([y, x0, dw]) => ({ kind: 'PlaceFloor' as const, y, x0, x1: x0 + dw }));

const placeStairsArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('PlaceStairs' as const),
  x: xArb,
  y: yArb,
});

const placeEscalatorArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('PlaceEscalator' as const),
  x: xArb,
  y: yArb,
});

const placeElevatorArb: fc.Arbitrary<Command> = fc
  .tuple(xArb, yArb, fc.integer({ min: 0, max: 8 }))
  .map(([x, yMin, span]) => ({ kind: 'PlaceElevator' as const, x, yMin, yMax: yMin + span }));

const extendElevatorArb: fc.Arbitrary<Command> = fc
  .tuple(idArb, fc.integer({ min: -3, max: 2 }), fc.integer({ min: 0, max: 10 }))
  .map(([transportId, yMin, span]) => ({
    kind: 'ExtendElevator' as const,
    transportId,
    yMin,
    yMax: yMin + span,
  }));

const addCarArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('AddElevatorCar' as const),
  transportId: idArb,
});

const demolishArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('Demolish' as const),
  x: xArb,
  y: yArb,
});

const setSpeedArb: fc.Arbitrary<Command> = fc.record({
  kind: fc.constant('SetSpeed' as const),
  speed: fc.constantFrom(0 as const, 1 as const, 2 as const, 3 as const),
});

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { arbitrary: placeRoomArb, weight: 6 },
  { arbitrary: placeFloorArb, weight: 4 },
  { arbitrary: placeStairsArb, weight: 2 },
  { arbitrary: placeEscalatorArb, weight: 1 },
  { arbitrary: placeElevatorArb, weight: 2 },
  { arbitrary: extendElevatorArb, weight: 1 },
  { arbitrary: addCarArb, weight: 1 },
  { arbitrary: demolishArb, weight: 4 },
  { arbitrary: setSpeedArb, weight: 1 },
);

const commandSeqArb = fc.array(commandArb, { minLength: 5, maxLength: 50 });

// ---------------------------------------------------------------------------
// 1. No overlaps
// ---------------------------------------------------------------------------

describe('invariant: no overlaps', () => {
  test('after any accepted sequence, rooms never overlap rooms or transport footprints', () => {
    fc.assert(
      fc.property(commandSeqArb, (cmds) => {
        const state = freshTower();
        for (const cmd of cmds) {
          const res = applyCommand(state, cmd);
          if (res.ok) {
            const violations = overlapViolations(state);
            expect(violations, `after ${JSON.stringify(cmd)}`).toEqual([]);
          }
        }
      }),
      { seed: 20260706, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Validation is never bypassed
// ---------------------------------------------------------------------------

describe('invariant: applyCommand agrees with the rule validators', () => {
  test('verdict, failure reason and cost all match; rejected commands change nothing', () => {
    fc.assert(
      fc.property(commandSeqArb, (cmds) => {
        const state = freshTower();
        for (const cmd of cmds) {
          const expected = expectedVerdict(state, cmd);
          const moneyBefore = state.money;
          const roomsBefore = state.rooms.length;
          const transportsBefore = state.transports.length;
          const res = applyCommand(state, cmd);
          const label = JSON.stringify(cmd);
          if (expected.ok) {
            expect(res, label).toEqual({ ok: true, cost: expected.cost });
            expect(state.money, `money after accepted ${label}`).toBe(moneyBefore - expected.cost);
          } else {
            expect(res, label).toEqual({ ok: false, reason: expected.reason });
            expect(state.money, `money after rejected ${label}`).toBe(moneyBefore);
            expect(state.rooms.length, `rooms after rejected ${label}`).toBe(roomsBefore);
            expect(state.transports.length, `transports after rejected ${label}`).toBe(transportsBefore);
          }
        }
      }),
      { seed: 19940111, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Money never goes negative from construction
// ---------------------------------------------------------------------------

describe('invariant: construction cannot overdraw', () => {
  test('money stays >= 0 and only ever moves by exactly the returned cost', () => {
    const startMoneyArb = fc.oneof(
      fc.constant(BALANCE.startingMoney),
      fc.integer({ min: 0, max: 12_000 }), // tight budgets exercise the affordability gate
    );
    fc.assert(
      fc.property(startMoneyArb, commandSeqArb, (startMoney, cmds) => {
        const state = createInitialState(7, startMoney);
        let expectedMoney = startMoney;
        for (const cmd of [LOBBY_CMD, ...cmds]) {
          const res = applyCommand(state, cmd);
          if (res.ok) expectedMoney -= res.cost;
          expect(state.money, `after ${JSON.stringify(cmd)}`).toBe(expectedMoney);
          expect(state.money, `after ${JSON.stringify(cmd)}`).toBeGreaterThanOrEqual(0);
        }
      }),
      { seed: 55501, numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Structural support
// ---------------------------------------------------------------------------

describe('invariant: structural support', () => {
  test('after any accepted sequence (including Demolish), every structure cell is supported', () => {
    fc.assert(
      fc.property(commandSeqArb, (cmds) => {
        const state = freshTower();
        for (const cmd of cmds) {
          const res = applyCommand(state, cmd);
          if (res.ok) {
            expect(supportViolations(state), `after ${JSON.stringify(cmd)}`).toEqual([]);
          }
        }
      }),
      { seed: 77007, numRuns: 100 },
    );
  });

  // Regression: canRemoveStructureCell once ignored basement dependents when
  // demolishing ground cells (y = 0 supports both y = 1 and y = -1).
  test('demolishing ground structure never strands basement cells built beneath it', () => {
    // Ground floor over the basement, parking below, then knock out the
    // ground cells directly above the parking one by one. The demolish rule
    // must refuse once a basement cell would lose all support.
    const state = freshTower();
    expect(applyCommand(state, { kind: 'PlaceFloor', y: 0, x0: 52, x1: 60 }).ok).toBe(true);
    expect(applyCommand(state, { kind: 'PlaceRoom', type: 'parking', x: 52, y: -1 }).ok).toBe(true);
    for (const x of [53, 54, 55]) {
      applyCommand(state, { kind: 'Demolish', x, y: 0 }); // accepted or not — invariant must hold
    }
    expect(supportViolations(state)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Star gating
// ---------------------------------------------------------------------------

describe('invariant: star gating at 1 star', () => {
  const gatedTypes = ROOM_TYPES.filter((t) => ROOM_CATALOG[t].starRequired > 1);
  const openTypes = ROOM_TYPES.filter((t) => ROOM_CATALOG[t].starRequired === 1);

  test('every room type with starRequired > 1 is rejected with star-locked', () => {
    expect(gatedTypes.length).toBeGreaterThan(0);
    for (const type of gatedTypes) {
      const state = freshTower();
      // (40, 2) is in bounds and inside the 1-star height band, so the star
      // gate is the rule that decides.
      const res = applyCommand(state, { kind: 'PlaceRoom', type, x: 40, y: 2 });
      expect(res, type).toEqual({ ok: false, reason: 'star-locked' });
    }
  });

  test('room types with starRequired === 1 never fail with star-locked', () => {
    fc.assert(
      fc.property(fc.constantFrom(...openTypes), xArb, yArb, (type, x, y) => {
        const state = freshTower();
        const res = applyCommand(state, { kind: 'PlaceRoom', type, x, y });
        if (!res.ok) expect(res.reason).not.toBe('star-locked');
      }),
      { seed: 31337, numRuns: 150 },
    );
  });

  test('escalators are star-locked at 1 star everywhere', () => {
    fc.assert(
      fc.property(xArb, yArb, (x, y) => {
        const state = freshTower();
        const res = applyCommand(state, { kind: 'PlaceEscalator', x, y });
        expect(res).toEqual({ ok: false, reason: 'star-locked' });
      }),
      { seed: 90210, numRuns: 60 },
    );
  });
});
