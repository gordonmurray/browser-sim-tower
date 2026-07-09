/**
 * Grid helpers: floor structure (runs of built cells), occupancy queries and
 * the structural-support rule. Structure runs double as the walkable floor
 * segments used by the transport graph.
 */
import type { FloorRun, FloorStructure, Room, TowerState, Transport } from '../state';

export function getFloor(state: TowerState, y: number): FloorStructure | undefined {
  return state.structure.find((f) => f.y === y);
}

export function hasStructure(state: TowerState, x: number, y: number): boolean {
  const floor = getFloor(state, y);
  if (!floor) return false;
  return floor.runs.some((r) => x >= r.x0 && x <= r.x1);
}

/** Count cells in [x0..x1] on floor y that have no structure yet. */
export function missingStructureCells(state: TowerState, y: number, x0: number, x1: number): number {
  const floor = getFloor(state, y);
  let missing = x1 - x0 + 1;
  if (!floor) return missing;
  for (const r of floor.runs) {
    const lo = Math.max(x0, r.x0);
    const hi = Math.min(x1, r.x1);
    if (hi >= lo) missing -= hi - lo + 1;
  }
  return missing;
}

/** Add structure cells [x0..x1] on floor y, merging runs. Keeps floors sorted by y. */
export function addStructure(state: TowerState, y: number, x0: number, x1: number): void {
  let floor = getFloor(state, y);
  if (!floor) {
    floor = { y, runs: [] };
    state.structure.push(floor);
    state.structure.sort((a, b) => a.y - b.y);
  }
  const runs: FloorRun[] = [...floor.runs, { x0, x1 }].sort((a, b) => a.x0 - b.x0);
  const merged: FloorRun[] = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.x0 <= last.x1 + 1) {
      last.x1 = Math.max(last.x1, r.x1);
    } else {
      merged.push({ x0: r.x0, x1: r.x1 });
    }
  }
  floor.runs = merged;
}

/** Remove structure cells [x0..x1] on floor y, splitting runs. */
export function removeStructure(state: TowerState, y: number, x0: number, x1: number): void {
  const floor = getFloor(state, y);
  if (!floor) return;
  const next: FloorRun[] = [];
  for (const r of floor.runs) {
    if (r.x1 < x0 || r.x0 > x1) {
      next.push(r);
      continue;
    }
    if (r.x0 < x0) next.push({ x0: r.x0, x1: x0 - 1 });
    if (r.x1 > x1) next.push({ x0: x1 + 1, x1: r.x1 });
  }
  floor.runs = next;
  if (next.length === 0) {
    state.structure = state.structure.filter((f) => f !== floor);
  }
}

/**
 * Support rule: a new structure cell above ground (y >= 1) needs structure on
 * the floor below at x-1, x or x+1 (allows one cell of stepped overhang).
 * Basement cells (y <= -1) mirror this against the floor above. Cells being
 * built in the same action count as present, so a room's own row self-supports
 * only via the floor beneath it, checked cell by cell.
 */
export function isCellSupported(state: TowerState, x: number, y: number): boolean {
  if (y === 0) return true; // ground floor rests on the ground
  const below = y > 0 ? y - 1 : y + 1;
  return (
    hasStructure(state, x - 1, below) ||
    hasStructure(state, x, below) ||
    hasStructure(state, x + 1, below)
  );
}

export function isRunSupported(state: TowerState, y: number, x0: number, x1: number): boolean {
  for (let x = x0; x <= x1; x++) {
    if (!isCellSupported(state, x, y)) return false;
  }
  return true;
}

/**
 * A structure cell may be demolished only if nothing rests on it. Above-ground
 * cells support the floor above (y+1); cells at or below ground also support
 * the basement chain hanging beneath them (y-1). Ground (y=0) supports both.
 */
export function canRemoveStructureCell(state: TowerState, x: number, y: number): boolean {
  const dependents: number[] = [];
  if (y >= 0) dependents.push(y + 1);
  if (y <= 0) dependents.push(y - 1);
  return !dependents.some(
    (dy) =>
      hasStructure(state, x - 1, dy) ||
      hasStructure(state, x, dy) ||
      hasStructure(state, x + 1, dy),
  );
}

export function roomAt(state: TowerState, x: number, y: number): Room | undefined {
  return state.rooms.find((r) => y >= r.y && y < r.y + r.h && x >= r.x && x < r.x + r.w);
}

export function transportAt(state: TowerState, x: number, y: number): Transport | undefined {
  return state.transports.find((t) => y >= t.yMin && y <= t.yMax && x >= t.x && x < t.x + t.w);
}

/** True if the rect overlaps no room and no transport. */
export function rectFree(state: TowerState, x: number, y: number, w: number, h: number): boolean {
  for (const r of state.rooms) {
    if (x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y) return false;
  }
  for (const t of state.transports) {
    if (x < t.x + t.w && x + w > t.x && y <= t.yMax && y + h - 1 >= t.yMin) return false;
  }
  return true;
}

/** The run (walkable segment) containing cell x on floor y, if any. */
export function runAt(state: TowerState, x: number, y: number): FloorRun | undefined {
  const floor = getFloor(state, y);
  return floor?.runs.find((r) => x >= r.x0 && x <= r.x1);
}
