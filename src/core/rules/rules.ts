/**
 * Placement rules. Every rule is a small named predicate returning null (pass)
 * or a typed FailureReason. The validators run the full set and also compute
 * the total cost (room/transport cost + auto-built structure).
 */
import {
  ELEVATOR_MAX_SPAN,
  ELEVATOR_SHAFT_WIDTH,
  GRID_WIDTH,
  MAX_CARS_PER_SHAFT,
} from '../constants';
import {
  canRemoveStructureCell,
  hasStructure,
  isCellSupported,
  missingStructureCells,
  rectFree,
  roomAt,
  transportAt,
} from '../grid/grid';
import {
  BALANCE,
  MAX_FLOOR_BY_STAR,
  MIN_FLOOR_BY_STAR,
  ROOM_CATALOG,
  type RoomTypeDef,
} from '../rooms/catalog';
import type { FloorRun, RoomTypeId, TowerState, Transport } from '../state';

export type FailureReason =
  | 'insufficient-funds'
  | 'out-of-bounds'
  | 'height-limit'
  | 'star-locked'
  | 'needs-lobby'
  | 'ground-floor-is-lobby-only'
  | 'lobby-must-be-on-ground'
  | 'must-be-above-ground'
  | 'must-be-basement'
  | 'not-on-ground-floor'
  | 'overlaps'
  | 'no-support'
  | 'needs-structure'
  | 'too-noisy'
  | 'disturbs-neighbours'
  | 'invalid-range'
  | 'span-too-long'
  | 'max-cars-reached'
  | 'nothing-to-demolish'
  | 'demolish-supporting-structure'
  | 'not-an-elevator';

export const FAILURE_MESSAGES: Record<FailureReason, string> = {
  'insufficient-funds': 'Not enough money.',
  'out-of-bounds': 'Outside the buildable area.',
  'height-limit': 'Beyond the height limit for your star rating.',
  'star-locked': 'Locked — raise your star rating to unlock.',
  'needs-lobby': 'Build a lobby on the ground floor first.',
  'ground-floor-is-lobby-only': 'Only lobbies can be built on the ground floor.',
  'lobby-must-be-on-ground': 'Lobbies must be on the ground floor.',
  'must-be-above-ground': 'Must be built above ground level.',
  'must-be-basement': 'Must be built underground.',
  'not-on-ground-floor': 'Cannot be built on the ground floor.',
  overlaps: 'Overlaps another room or shaft.',
  'no-support': 'No structure underneath to support this.',
  'needs-structure': 'Needs floor structure on both floors first.',
  'too-noisy': 'Too noisy here — a noisy neighbour is adjacent.',
  'disturbs-neighbours': 'Would disturb quiet neighbours next door.',
  'invalid-range': 'Invalid vertical range.',
  'span-too-long': `Elevators span at most ${ELEVATOR_MAX_SPAN} floors.`,
  'max-cars-reached': `A shaft holds at most ${MAX_CARS_PER_SHAFT} cars.`,
  'nothing-to-demolish': 'Nothing to demolish here.',
  'demolish-supporting-structure': 'Clear the floors resting on this first.',
  'not-an-elevator': 'That is not an elevator shaft.',
};

export type Validation =
  | { ok: true; cost: number }
  | { ok: false; reason: FailureReason };

function fail(reason: FailureReason): Validation {
  return { ok: false, reason };
}

// ---------------------------------------------------------------------------
// Named predicates
// ---------------------------------------------------------------------------

export function ruleWithinBounds(x0: number, x1: number): FailureReason | null {
  return x0 >= 0 && x1 < GRID_WIDTH ? null : 'out-of-bounds';
}

export function ruleWithinStarHeight(state: TowerState, yMin: number, yMax: number): FailureReason | null {
  const idx = state.stars.rating - 1;
  const maxY = MAX_FLOOR_BY_STAR[idx] ?? 10;
  const minY = MIN_FLOOR_BY_STAR[idx] ?? -2;
  return yMin >= minY && yMax <= maxY ? null : 'height-limit';
}

export function ruleStarUnlocked(state: TowerState, def: RoomTypeDef): FailureReason | null {
  return state.stars.rating >= def.starRequired ? null : 'star-locked';
}

export function ruleLobbyExists(state: TowerState): FailureReason | null {
  return state.rooms.some((r) => r.type === 'lobby') ? null : 'needs-lobby';
}

export function ruleFloorConstraint(def: RoomTypeDef, y: number): FailureReason | null {
  if (def.groundOnly && y !== 0) return 'lobby-must-be-on-ground';
  if (def.aboveGroundOnly && y < 1) return 'must-be-above-ground';
  if (def.basementOnly && y > -1) return 'must-be-basement';
  if (def.notOnGround && y === 0) return 'not-on-ground-floor';
  if (!def.groundOnly && y === 0) return 'ground-floor-is-lobby-only';
  return null;
}

export function ruleNoOverlap(state: TowerState, x: number, y: number, w: number, h: number): FailureReason | null {
  return rectFree(state, x, y, w, h) ? null : 'overlaps';
}

/** Every cell that would be auto-built must satisfy the support rule. */
export function ruleSupported(state: TowerState, y: number, x0: number, x1: number): FailureReason | null {
  for (let x = x0; x <= x1; x++) {
    if (!hasStructure(state, x, y) && !isCellSupported(state, x, y)) return 'no-support';
  }
  return null;
}

export function ruleAffordable(state: TowerState, cost: number): FailureReason | null {
  return state.money >= cost ? null : 'insufficient-funds';
}

/**
 * Noise adjacency: a noise-sensitive room may not sit next to (or directly
 * above/below) a noisy one, and vice versa. Blocking (not warning) keeps the
 * invariant property-testable.
 */
export function ruleNoise(state: TowerState, def: RoomTypeDef, x: number, y: number): FailureReason | null {
  const neighbours = state.rooms.filter((r) => {
    const horizAdjacent = r.y === y && (r.x + r.w === x || x + def.w === r.x);
    const overlapX = r.x < x + def.w && x < r.x + r.w;
    const vertAdjacent = overlapX && Math.abs(r.y - y) === 1;
    return horizAdjacent || vertAdjacent;
  });
  if (def.noiseSensitive && neighbours.some((r) => ROOM_CATALOG[r.type].noisy)) return 'too-noisy';
  if (def.noisy && neighbours.some((r) => ROOM_CATALOG[r.type].noiseSensitive)) return 'disturbs-neighbours';
  return null;
}

// ---------------------------------------------------------------------------
// Validators (compose predicates, compute cost)
// ---------------------------------------------------------------------------

export function validateRoomPlacement(state: TowerState, type: RoomTypeId, x: number, y: number): Validation {
  const def = ROOM_CATALOG[type];
  const x1 = x + def.w - 1;

  let r: FailureReason | null;
  if ((r = ruleWithinBounds(x, x1))) return fail(r);
  if ((r = ruleWithinStarHeight(state, y, y + def.h - 1))) return fail(r);
  if ((r = ruleStarUnlocked(state, def))) return fail(r);
  if (type !== 'lobby' && (r = ruleLobbyExists(state))) return fail(r);
  if ((r = ruleFloorConstraint(def, y))) return fail(r);
  if ((r = ruleNoOverlap(state, x, y, def.w, def.h))) return fail(r);
  if ((r = ruleSupported(state, y, x, x1))) return fail(r);
  if ((r = ruleNoise(state, def, x, y))) return fail(r);

  const missing = missingStructureCells(state, y, x, x1);
  const cost = def.cost + missing * BALANCE.structureCostPerCell;
  if ((r = ruleAffordable(state, cost))) return fail(r);
  return { ok: true, cost };
}

/**
 * Which cells of a floor drag can actually be built: cells that already have
 * structure are silent no-ops, unsupported cells are skipped. Support for a
 * floor cell depends only on the adjacent floor (below above ground, above in
 * the basement), so cells are independent and the result order-free.
 */
export function planFloorCells(
  state: TowerState,
  y: number,
  x0: number,
  x1: number,
): { segments: FloorRun[]; newCells: number; existingCells: number } {
  const segments: FloorRun[] = [];
  let newCells = 0;
  let existingCells = 0;
  let open: FloorRun | null = null;
  for (let x = x0; x <= x1; x++) {
    if (hasStructure(state, x, y)) {
      existingCells += 1;
      open = null;
      continue;
    }
    if (!isCellSupported(state, x, y)) {
      open = null;
      continue;
    }
    newCells += 1;
    if (open && open.x1 === x - 1) {
      open.x1 = x;
    } else {
      open = { x0: x, x1: x };
      segments.push(open);
    }
  }
  return { segments, newCells, existingCells };
}

/**
 * Floor placement builds every buildable cell of the drag (partial placement):
 * a 30-cell drag with two unsupported edge cells builds the 28 good ones
 * instead of failing outright. Fails only when nothing in the drag can be
 * built at all.
 */
export function validateFloorPlacement(state: TowerState, y: number, x0: number, x1: number): Validation {
  let r: FailureReason | null;
  if (x0 > x1) return fail('invalid-range');
  if ((r = ruleWithinBounds(x0, x1))) return fail(r);
  if ((r = ruleWithinStarHeight(state, y, y))) return fail(r);
  if ((r = ruleLobbyExists(state))) return fail(r);
  const plan = planFloorCells(state, y, x0, x1);
  if (plan.newCells === 0) {
    // Entirely-existing structure is a free no-op; otherwise nothing here can
    // be supported.
    if (plan.existingCells === x1 - x0 + 1) return { ok: true, cost: 0 };
    return fail('no-support');
  }
  const cost = plan.newCells * BALANCE.structureCostPerCell;
  if ((r = ruleAffordable(state, cost))) return fail(r);
  return { ok: true, cost };
}

/**
 * Structure the shaft auto-builds so floors it crosses through existing
 * construction get landings (charged per cell). Rows over open sky are
 * skipped — a shaft may pass floors it does not serve. Scanned outward from
 * the ground so a full column chains its own support upward/downward.
 */
export function planElevatorAutoBuild(
  state: TowerState,
  x: number,
  yFrom: number,
  yTo: number,
): Array<{ y: number; x0: number; x1: number }> {
  const w = ELEVATOR_SHAFT_WIDTH;
  const virtual = new Set<string>();
  const has = (cx: number, cy: number): boolean =>
    hasStructure(state, cx, cy) || virtual.has(`${cx},${cy}`);
  const supported = (cx: number, cy: number): boolean => {
    if (cy === 0) return true;
    const toward = cy > 0 ? cy - 1 : cy + 1;
    return has(cx - 1, toward) || has(cx, toward) || has(cx + 1, toward);
  };
  const ys: number[] = [];
  for (let y = yFrom; y <= yTo; y++) ys.push(y);
  // Outward from the ground, so above-ground rows chain support upward and
  // basement rows chain downward within this same placement.
  ys.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  const runs: Array<{ y: number; x0: number; x1: number }> = [];
  for (const y of ys) {
    let open: { y: number; x0: number; x1: number } | null = null;
    for (let cx = x; cx < x + w; cx++) {
      if (has(cx, y) || !supported(cx, y)) {
        open = null;
        continue;
      }
      virtual.add(`${cx},${y}`);
      if (open && open.x1 === cx - 1) {
        open.x1 = cx;
      } else {
        open = { y, x0: cx, x1: cx };
        runs.push(open);
      }
    }
  }
  return runs;
}

function autoBuildCellCount(runs: Array<{ y: number; x0: number; x1: number }>): number {
  return runs.reduce((n, r) => n + (r.x1 - r.x0 + 1), 0);
}

/** Stairs and escalators occupy a w×2 footprint spanning floors y and y+1. */
export function validateStairlike(
  state: TowerState,
  kind: 'stairs' | 'escalator',
  x: number,
  y: number,
  w: number,
): Validation {
  const x1 = x + w - 1;
  let r: FailureReason | null;
  if (kind === 'escalator' && state.stars.rating < 2) return fail('star-locked');
  if ((r = ruleWithinBounds(x, x1))) return fail(r);
  if ((r = ruleWithinStarHeight(state, y, y + 1))) return fail(r);
  if ((r = ruleLobbyExists(state))) return fail(r);
  if ((r = ruleNoOverlap(state, x, y, w, 2))) return fail(r);
  if ((r = ruleSupported(state, y, x, x1))) return fail(r);
  // The upper row needs no support check: it rests directly on the lower row,
  // which exists after this placement's auto-build.
  const missing =
    missingStructureCells(state, y, x, x1) + missingStructureCells(state, y + 1, x, x1);
  const base = kind === 'stairs' ? BALANCE.stairsCost : BALANCE.escalatorCost;
  const cost = base + missing * BALANCE.structureCostPerCell;
  if ((r = ruleAffordable(state, cost))) return fail(r);
  return { ok: true, cost };
}

export function validateElevatorPlacement(state: TowerState, x: number, yMin: number, yMax: number): Validation {
  const w = ELEVATOR_SHAFT_WIDTH;
  const x1 = x + w - 1;
  let r: FailureReason | null;
  if (yMin > yMax) return fail('invalid-range');
  if (yMax - yMin + 1 > ELEVATOR_MAX_SPAN) return fail('span-too-long');
  if ((r = ruleWithinBounds(x, x1))) return fail(r);
  if ((r = ruleWithinStarHeight(state, yMin, yMax))) return fail(r);
  if ((r = ruleLobbyExists(state))) return fail(r);
  if ((r = ruleNoOverlap(state, x, yMin, w, yMax - yMin + 1))) return fail(r);
  const span = yMax - yMin + 1;
  const autoCells = autoBuildCellCount(planElevatorAutoBuild(state, x, yMin, yMax));
  const cost =
    BALANCE.elevatorBaseCost +
    span * BALANCE.elevatorCostPerFloor +
    BALANCE.elevatorCarsIncluded * BALANCE.elevatorCarCost +
    autoCells * BALANCE.structureCostPerCell;
  if ((r = ruleAffordable(state, cost))) return fail(r);
  return { ok: true, cost };
}

export function validateExtendElevator(
  state: TowerState,
  shaft: Transport,
  yMin: number,
  yMax: number,
): Validation {
  if (shaft.type !== 'elevator') return fail('not-an-elevator');
  if (yMin > shaft.yMin || yMax < shaft.yMax) return fail('invalid-range');
  if (yMin === shaft.yMin && yMax === shaft.yMax) return fail('invalid-range');
  if (yMax - yMin + 1 > ELEVATOR_MAX_SPAN) return fail('span-too-long');
  let r: FailureReason | null;
  if ((r = ruleWithinStarHeight(state, yMin, yMax))) return fail(r);
  // Only the newly covered rows must be free.
  const w = shaft.w;
  for (let y = yMin; y < shaft.yMin; y++) {
    if ((r = ruleNoOverlap(state, shaft.x, y, w, 1))) return fail(r);
  }
  for (let y = shaft.yMax + 1; y <= yMax; y++) {
    if ((r = ruleNoOverlap(state, shaft.x, y, w, 1))) return fail(r);
  }
  const added = shaft.yMin - yMin + (yMax - shaft.yMax);
  const autoCells = autoBuildCellCount(extendElevatorAutoBuild(state, shaft, yMin, yMax));
  const cost = added * BALANCE.elevatorCostPerFloor + autoCells * BALANCE.structureCostPerCell;
  if ((r = ruleAffordable(state, cost))) return fail(r);
  return { ok: true, cost };
}

/** Auto-build plan for just the newly covered rows of an extension. */
export function extendElevatorAutoBuild(
  state: TowerState,
  shaft: Transport,
  yMin: number,
  yMax: number,
): Array<{ y: number; x0: number; x1: number }> {
  const runs: Array<{ y: number; x0: number; x1: number }> = [];
  if (yMin < shaft.yMin) runs.push(...planElevatorAutoBuild(state, shaft.x, yMin, shaft.yMin - 1));
  if (yMax > shaft.yMax) runs.push(...planElevatorAutoBuild(state, shaft.x, shaft.yMax + 1, yMax));
  return runs;
}

export function validateAddCar(state: TowerState, shaft: Transport): Validation {
  if (shaft.type !== 'elevator' || !shaft.cars) return fail('not-an-elevator');
  if (shaft.cars.length >= MAX_CARS_PER_SHAFT) return fail('max-cars-reached');
  const cost = BALANCE.elevatorCarCost;
  const r = ruleAffordable(state, cost);
  if (r) return fail(r);
  return { ok: true, cost };
}

export type DemolishTarget =
  | { kind: 'room'; roomId: number }
  | { kind: 'transport'; transportId: number }
  | { kind: 'structure'; x: number; y: number };

export function validateDemolish(state: TowerState, x: number, y: number):
  | { ok: true; cost: number; target: DemolishTarget }
  | { ok: false; reason: FailureReason } {
  const room = roomAt(state, x, y);
  if (room) return { ok: true, cost: 0, target: { kind: 'room', roomId: room.id } };
  const transport = transportAt(state, x, y);
  if (transport) return { ok: true, cost: 0, target: { kind: 'transport', transportId: transport.id } };
  if (hasStructure(state, x, y)) {
    if (!canRemoveStructureCell(state, x, y)) return { ok: false, reason: 'demolish-supporting-structure' };
    return { ok: true, cost: 0, target: { kind: 'structure', x, y } };
  }
  return { ok: false, reason: 'nothing-to-demolish' };
}
