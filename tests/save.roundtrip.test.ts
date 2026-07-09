/**
 * Save-layer tests (src/save): serialize/deserialize round-trips, the
 * migration runner, and the envelope format. serialize/deserialize are pure
 * (no localStorage needed), so everything here runs headless.
 *
 * Covered:
 *   1. Round-trip identity on a non-trivial mid-flight tower (people riding
 *      elevators, ledger populated): deserialize(serialize(s)) deep-equals s
 *      and is byte-identical under JSON.stringify.
 *   2. Tick-identical continuation: a round-tripped copy ticks byte-identically
 *      to the original for 2000 more minutes (checkpoints every 500).
 *   3. fast-check property: round-trip identity holds after arbitrary small
 *      command sequences (accepted or rejected) plus arbitrary tick counts.
 *   4. Migration runner: garbage JSON, non-envelope JSON, too-new versions,
 *      unknown/negative versions, stalled migrations, and a working
 *      (temporarily registered) migration chain.
 *   5. serialize embeds saveVersion === CURRENT_SAVE_VERSION.
 *
 * All seeds are fixed; the core is deterministic, so these tests are too.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { applyCommand, tick, type Command } from '../src/core/engine';
import { createInitialState, type RoomTypeId, type TowerState } from '../src/core/state';
import { BALANCE } from '../src/core/rooms/catalog';
import { CURRENT_SAVE_VERSION } from '../src/save/schema';
import { MIGRATIONS, migrateToCurrent, SaveError } from '../src/save/migrations';
import { deserialize, serialize } from '../src/save/storage';

// ---------------------------------------------------------------------------
// Fixture tower
// ---------------------------------------------------------------------------

/**
 * Ground floor: lobbies covering x=40..59, bare structure x=60..70 for the
 * elevator/stairs landings (the ground floor accepts only lobby *rooms*, but
 * PlaceFloor structure is fine). Floors 1..5 span x=40..70; a basement floor
 * at y=-1 (x=42..62) holds parking and gives the shaft a basement landing.
 * Offices, a condo and a fastfood exercise office/residence/retail state;
 * hotel rooms require 2 stars, unreachable at this population, so none here.
 * The elevator spans -1..5; stairs are staggered so footprints never overlap.
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
  { kind: 'PlaceFloor', y: -1, x0: 42, x1: 62 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 1 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 1 },
  { kind: 'PlaceRoom', type: 'fastfood', x: 52, y: 1 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 2 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 2 },
  { kind: 'PlaceRoom', type: 'condo', x: 40, y: 3 },
  { kind: 'PlaceRoom', type: 'office', x: 48, y: 3 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 4 },
  { kind: 'PlaceRoom', type: 'office', x: 46, y: 4 },
  { kind: 'PlaceRoom', type: 'office', x: 40, y: 5 },
  { kind: 'PlaceRoom', type: 'parking', x: 44, y: -1 },
  { kind: 'PlaceElevator', x: 60, yMin: -1, yMax: 5 },
  { kind: 'PlaceStairs', x: 64, y: 0 },
  { kind: 'PlaceStairs', x: 67, y: 1 },
  { kind: 'SetSpeed', speed: 2 },
];

function buildTower(seed: number): TowerState {
  const state = createInitialState(seed, BALANCE.startingMoney);
  for (const cmd of TOWER_COMMANDS) {
    const result = applyCommand(state, cmd);
    if (!result.ok) {
      throw new Error(`fixture command rejected (${result.reason}): ${JSON.stringify(cmd)}`);
    }
  }
  // A third car makes elevator state richer than the default.
  const shaft = state.transports.find((t) => t.type === 'elevator')!;
  const car = applyCommand(state, { kind: 'AddElevatorCar', transportId: shaft.id });
  if (!car.ok) throw new Error(`AddElevatorCar rejected: ${car.reason}`);
  return state;
}

function expectRoundTripIdentity(state: TowerState, savedAt: number): void {
  const json = serialize(state, savedAt);
  const copy = deserialize(json);
  expect(copy).toEqual(state);
  expect(JSON.stringify(copy)).toBe(JSON.stringify(state));
  // Serialising the copy reproduces the exact same save file.
  expect(serialize(copy, savedAt)).toBe(json);
}

// ---------------------------------------------------------------------------
// 1. Round-trip identity on a mid-flight tower
// ---------------------------------------------------------------------------

describe('round-trip identity', () => {
  it('deserialize(serialize(state)) is deep- and byte-identical after ~3000 ticks', () => {
    const state = buildTower(20260706);
    let sawPeople = false;
    for (let i = 0; i < 3000; i++) {
      tick(state);
      if (!sawPeople && state.people.length > 0) sawPeople = true;
    }
    // The fixture must actually be mid-flight, or the round-trip proves little.
    expect(sawPeople).toBe(true);
    expect(state.ledger.length).toBeGreaterThan(0);
    expect(state.rooms.some((r) => r.occupied && r.type === 'office')).toBe(true);

    expectRoundTripIdentity(state, 0);
  });

  it('holds for the pristine initial state too', () => {
    expectRoundTripIdentity(createInitialState(1, BALANCE.startingMoney), 1234567);
  });
});

// ---------------------------------------------------------------------------
// 2. Tick-identical continuation after a round trip
// ---------------------------------------------------------------------------

describe('tick-identical continuation', () => {
  it('a round-tripped copy ticks byte-identically for 2000 more minutes', () => {
    const original = buildTower(4242);
    for (let i = 0; i < 1500; i++) tick(original); // mid-flight snapshot point

    const copy = deserialize(serialize(original, 987654321));
    expect(JSON.stringify(copy)).toBe(JSON.stringify(original));

    // Ticking interleaved stresses any module-level caches keyed on state
    // identity: the copy is a different object and must behave identically.
    for (let i = 1; i <= 2000; i++) {
      tick(original);
      tick(copy);
      if (i % 500 === 0) {
        const jo = JSON.stringify(original);
        const jc = JSON.stringify(copy);
        if (jo !== jc) {
          // Targeted diff first, then the byte-level assertion.
          expect(JSON.parse(jc), `divergence ${i} ticks after round-trip`).toEqual(JSON.parse(jo));
          expect(jc, `stringify divergence ${i} ticks after round-trip`).toBe(jo);
        }
      }
    }
    expect(JSON.stringify(copy)).toBe(JSON.stringify(original));
  });
});

// ---------------------------------------------------------------------------
// 3. Property: round-trip identity after arbitrary commands + ticks
// ---------------------------------------------------------------------------

const roomTypeArb = fc.constantFrom<RoomTypeId>(
  'lobby',
  'office',
  'condo',
  'fastfood',
  'shop',
  'hotelSingle',
  'parking',
);

/**
 * Random commands aimed near the lobby so a useful fraction are accepted;
 * rejected commands are fine (applyCommand must leave state valid either way).
 */
const commandArb: fc.Arbitrary<Command> = fc.oneof(
  fc
    .tuple(roomTypeArb, fc.integer({ min: 30, max: 66 }), fc.integer({ min: -2, max: 6 }))
    .map(([type, x, y]): Command => ({ kind: 'PlaceRoom', type, x, y })),
  fc
    .tuple(fc.integer({ min: -2, max: 6 }), fc.integer({ min: 30, max: 60 }), fc.integer({ min: 30, max: 70 }))
    .map(([y, x0, x1]): Command => ({ kind: 'PlaceFloor', y, x0, x1 })),
  fc
    .tuple(fc.integer({ min: 30, max: 64 }), fc.integer({ min: 0, max: 5 }))
    .map(([x, y]): Command => ({ kind: 'PlaceStairs', x, y })),
  fc
    .tuple(fc.integer({ min: 30, max: 64 }), fc.integer({ min: 0, max: 5 }))
    .map(([x, y]): Command => ({ kind: 'PlaceEscalator', x, y })),
  fc
    .tuple(fc.integer({ min: 30, max: 64 }), fc.integer({ min: 0, max: 8 }))
    .map(([x, yMax]): Command => ({ kind: 'PlaceElevator', x, yMin: 0, yMax })),
  fc
    .integer({ min: 1, max: 60 })
    .map((transportId): Command => ({ kind: 'AddElevatorCar', transportId })),
  fc
    .tuple(fc.integer({ min: 30, max: 70 }), fc.integer({ min: -2, max: 6 }))
    .map(([x, y]): Command => ({ kind: 'Demolish', x, y })),
  fc.constantFrom<0 | 1 | 2 | 3>(0, 1, 2, 3).map((speed): Command => ({ kind: 'SetSpeed', speed })),
);

describe('round-trip property', () => {
  it('holds after arbitrary command sequences and tick counts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7fffffff }),
        fc.array(commandArb, { maxLength: 25 }),
        fc.integer({ min: 0, max: 1000 }),
        (seed, cmds, ticks) => {
          const state = createInitialState(seed, BALANCE.startingMoney);
          // Seed a lobby so later commands have something to build on.
          applyCommand(state, { kind: 'PlaceRoom', type: 'lobby', x: 48, y: 0 });
          for (const cmd of cmds) applyCommand(state, cmd); // rejections allowed
          for (let i = 0; i < ticks; i++) tick(state);
          expectRoundTripIdentity(state, 42);
        },
      ),
      { numRuns: 10, seed: 42 },
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Migration runner
// ---------------------------------------------------------------------------

describe('migration runner', () => {
  it('deserialize rejects garbage JSON with SaveError', () => {
    expect(() => deserialize('{not json at all')).toThrow(SaveError);
    expect(() => deserialize('{not json at all')).toThrow(/JSON/);
    expect(() => deserialize('')).toThrow(SaveError);
  });

  it('rejects parseable JSON that is not a save envelope', () => {
    expect(() => deserialize('null')).toThrow(SaveError);
    expect(() => deserialize('42')).toThrow(SaveError);
    expect(() => deserialize('"saveVersion"')).toThrow(SaveError);
    expect(() => deserialize('[]')).toThrow(SaveError);
    expect(() => deserialize('{"money":100}')).toThrow(SaveError);
    expect(() => deserialize('{"saveVersion":"1"}')).toThrow(SaveError); // string, not number
    expect(() => migrateToCurrent(undefined)).toThrow(SaveError);
    expect(() => migrateToCurrent({})).toThrow(SaveError);
  });

  it('rejects saves newer than the current version', () => {
    const newer = { saveVersion: CURRENT_SAVE_VERSION + 1 };
    expect(() => migrateToCurrent(newer)).toThrow(SaveError);
    expect(() => migrateToCurrent(newer)).toThrow(/newer/);
    expect(() => deserialize(JSON.stringify({ saveVersion: 999, savedAt: 0, state: {} }))).toThrow(
      SaveError,
    );
  });

  it('rejects unknown / negative versions that have no migration', () => {
    expect(() => migrateToCurrent({ saveVersion: 0 })).toThrow(SaveError);
    expect(() => migrateToCurrent({ saveVersion: 0 })).toThrow(/No migration/);
    expect(() => migrateToCurrent({ saveVersion: -3 })).toThrow(/No migration/);
    expect(() => migrateToCurrent({ saveVersion: 0.5 })).toThrow(/No migration/);
  });

  it('errors when a registered migration fails to advance the version', () => {
    // Temporarily register a broken migration that returns the same version.
    MIGRATIONS[0] = (save) => ({ ...save });
    try {
      expect(() => migrateToCurrent({ saveVersion: 0 })).toThrow(SaveError);
      expect(() => migrateToCurrent({ saveVersion: 0 })).toThrow(/did not advance/);
    } finally {
      delete MIGRATIONS[0];
    }
    // And one that goes backwards.
    MIGRATIONS[0] = (save) => ({ ...save, saveVersion: -1 });
    try {
      expect(() => migrateToCurrent({ saveVersion: 0 })).toThrow(/did not advance/);
    } finally {
      delete MIGRATIONS[0];
    }
    expect(MIGRATIONS[0]).toBeUndefined(); // clean restore
  });

  it('walks a temporarily registered migration chain to the current version', () => {
    const state = createInitialState(7, BALANCE.startingMoney);
    const oldSave = { saveVersion: 0, savedAt: 5, state: JSON.parse(JSON.stringify(state)) as unknown };
    MIGRATIONS[0] = (save) => ({ ...save, saveVersion: 1 });
    try {
      const file = migrateToCurrent(oldSave);
      expect(file.saveVersion).toBe(CURRENT_SAVE_VERSION);
      expect(file.state).toEqual(state);
      // The runner and migrations are pure: the input envelope is untouched.
      expect(oldSave.saveVersion).toBe(0);
    } finally {
      delete MIGRATIONS[0];
    }
  });

  it('passes a current-version save through unchanged', () => {
    const state = createInitialState(9, BALANCE.startingMoney);
    const file = migrateToCurrent({ saveVersion: CURRENT_SAVE_VERSION, savedAt: 77, state });
    expect(file.saveVersion).toBe(CURRENT_SAVE_VERSION);
    expect(file.savedAt).toBe(77);
    expect(file.state).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// 5. Envelope format
// ---------------------------------------------------------------------------

describe('save envelope', () => {
  it('serialize embeds saveVersion === CURRENT_SAVE_VERSION and savedAt', () => {
    const state = buildTower(1);
    const parsed = JSON.parse(serialize(state, 1720000000000)) as {
      saveVersion: unknown;
      savedAt: unknown;
      state: unknown;
    };
    expect(parsed.saveVersion).toBe(CURRENT_SAVE_VERSION);
    expect(parsed.savedAt).toBe(1720000000000);
    expect(parsed.state).toEqual(JSON.parse(JSON.stringify(state)));
  });
});
