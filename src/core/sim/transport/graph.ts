/**
 * Transport graph: nodes are floor segments (contiguous structure runs),
 * edges are transports linking segments on different floors. Used for both
 * reachability (rule 5) and per-person trip planning.
 *
 * This is the seam between "can you get there" and "how the elevators behave":
 * the graph decides routes; elevators.ts decides how long the elevator legs
 * actually take.
 */
import {
  ESCALATOR_MINUTES_PER_FLOOR,
  MAX_STAIR_FLOORS,
  STAIR_MINUTES_PER_FLOOR,
} from '../../constants';
import { runAt } from '../../grid/grid';
import type { FloorRun, TowerState, Transport, TripLeg } from '../../state';

interface SegmentNode {
  key: string;
  y: number;
  x0: number;
  x1: number;
}

interface SegmentEdge {
  from: string;
  to: string;
  transport: Transport;
  kind: 'elevator' | 'stairs' | 'escalator';
  fromFloor: number;
  toFloor: number;
  /** Cost in rough minutes, used by the router. */
  cost: number;
  /** Stair floors climbed (to cap total stair usage per trip). */
  stairFloors: number;
}

export interface TransportGraph {
  nodes: Map<string, SegmentNode>;
  adjacency: Map<string, SegmentEdge[]>;
}

function segKey(y: number, run: FloorRun): string {
  return `${y}:${run.x0}`;
}

function segmentAt(state: TowerState, x: number, y: number): SegmentNode | null {
  const run = runAt(state, x, y);
  if (!run) return null;
  return { key: segKey(y, run), y, x0: run.x0, x1: run.x1 };
}

/**
 * A transport connects to a floor where its footprint overlaps a segment.
 * Elevators additionally land on a segment that merely TOUCHES the shaft
 * (the doors open onto the corridor beside it) — otherwise a shaft placed
 * flush against a wall of rooms would serve nothing and the player has no
 * way to see why.
 */
function landingSegment(state: TowerState, t: Transport, y: number): SegmentNode | null {
  const reach = t.type === 'elevator' ? 1 : 0;
  for (let x = t.x - reach; x < t.x + t.w + reach; x++) {
    const seg = segmentAt(state, x, y);
    if (seg) return seg;
  }
  return null;
}

/**
 * Cache: rebuilding the graph on every planTrip call would be wasteful during
 * rush hour. The cache is invalidated by structureVersion, so it can never
 * change behaviour — only skip recomputation.
 */
let graphCache: { state: TowerState; version: number; graph: TransportGraph } | null = null;

export function getGraph(state: TowerState): TransportGraph {
  if (graphCache && graphCache.state === state && graphCache.version === state.structureVersion) {
    return graphCache.graph;
  }
  const graph = buildGraph(state);
  graphCache = { state, version: state.structureVersion, graph };
  return graph;
}

export function buildGraph(state: TowerState): TransportGraph {
  const nodes = new Map<string, SegmentNode>();
  const adjacency = new Map<string, SegmentEdge[]>();

  for (const floor of state.structure) {
    for (const run of floor.runs) {
      const node: SegmentNode = { key: segKey(floor.y, run), y: floor.y, x0: run.x0, x1: run.x1 };
      nodes.set(node.key, node);
      adjacency.set(node.key, []);
    }
  }

  const addEdge = (edge: SegmentEdge) => {
    adjacency.get(edge.from)?.push(edge);
  };

  for (const t of state.transports) {
    if (t.type === 'elevator') {
      // Consecutive served floors are linked; the router compresses runs on
      // the same shaft into one leg afterwards.
      let prev: { seg: SegmentNode; y: number } | null = null;
      for (let y = t.yMin; y <= t.yMax; y++) {
        const seg = landingSegment(state, t, y);
        if (!seg) continue;
        if (prev) {
          const cost = 2 + (y - prev.y) * 0.4; // wait estimate + travel
          addEdge({ from: prev.seg.key, to: seg.key, transport: t, kind: 'elevator', fromFloor: prev.y, toFloor: y, cost, stairFloors: 0 });
          addEdge({ from: seg.key, to: prev.seg.key, transport: t, kind: 'elevator', fromFloor: y, toFloor: prev.y, cost, stairFloors: 0 });
        }
        prev = { seg, y };
      }
    } else {
      const lower = landingSegment(state, t, t.yMin);
      const upper = landingSegment(state, t, t.yMax);
      if (lower && upper) {
        const kind = t.type;
        const perFloor = kind === 'stairs' ? STAIR_MINUTES_PER_FLOOR : ESCALATOR_MINUTES_PER_FLOOR;
        const stairFloors = kind === 'stairs' ? 1 : 0;
        addEdge({ from: lower.key, to: upper.key, transport: t, kind, fromFloor: t.yMin, toFloor: t.yMax, cost: perFloor, stairFloors });
        addEdge({ from: upper.key, to: lower.key, transport: t, kind, fromFloor: t.yMax, toFloor: t.yMin, cost: perFloor, stairFloors });
      }
    }
  }

  return { nodes, adjacency };
}

/** Segment keys on the ground floor that contain a lobby (tower entrances). */
export function entrySegmentKeys(state: TowerState): Set<string> {
  const keys = new Set<string>();
  for (const room of state.rooms) {
    if (room.type !== 'lobby') continue;
    const run = runAt(state, room.x, 0);
    if (run) keys.add(`0:${run.x0}`);
  }
  return keys;
}

/**
 * Recompute Room.reachable for every room: connected (via the graph) to a
 * ground segment containing a lobby. Rooms on a lobby segment itself count.
 *
 * The search honours the same stair cap as planTrip (nobody climbs more than
 * MAX_STAIR_FLOORS flights per trip), so "reachable" always means "people can
 * actually travel here" — a stairs-only room six floors up must not lease and
 * earn while every spawned trip toward it fails.
 */
export function recomputeReachability(state: TowerState): void {
  const graph = getGraph(state);
  const entries = entrySegmentKeys(state);
  // Dijkstra on cumulative stair flights (elevators/escalators cost 0).
  const bestStairs = new Map<string, number>();
  const queue: Array<{ key: string; stairs: number }> = [];
  for (const key of entries) {
    bestStairs.set(key, 0);
    queue.push({ key, stairs: 0 });
  }
  while (queue.length > 0) {
    const { key, stairs } = queue.shift()!;
    if ((bestStairs.get(key) ?? Infinity) < stairs) continue;
    for (const edge of graph.adjacency.get(key) ?? []) {
      const next = stairs + edge.stairFloors;
      if (next > MAX_STAIR_FLOORS) continue;
      if (next < (bestStairs.get(edge.to) ?? Infinity)) {
        bestStairs.set(edge.to, next);
        queue.push({ key: edge.to, stairs: next });
      }
    }
  }
  for (const room of state.rooms) {
    const run = runAt(state, room.x, room.y);
    room.reachable = run ? bestStairs.has(`${room.y}:${run.x0}`) : false;
  }
}

/**
 * Plan a trip between two cells as transport legs. Dijkstra over segments with
 * a stair-tolerance cap. Returns null if unreachable (or only reachable by
 * climbing more stairs than anyone will put up with).
 */
export function planTrip(
  state: TowerState,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
): TripLeg[] | null {
  const graph = getGraph(state);
  const start = segmentAt(state, fromX, fromY);
  const goal = segmentAt(state, toX, toY);
  if (!start || !goal) return null;
  if (start.key === goal.key) return [];

  interface Visit {
    key: string;
    cost: number;
    stairs: number;
    path: SegmentEdge[];
  }
  const best = new Map<string, number>();
  const frontier: Visit[] = [{ key: start.key, cost: 0, stairs: 0, path: [] }];
  best.set(start.key, 0);

  while (frontier.length > 0) {
    // Small graphs: linear extract-min keeps this simple and deterministic.
    let bestIdx = 0;
    for (let i = 1; i < frontier.length; i++) {
      const a = frontier[i]!;
      const b = frontier[bestIdx]!;
      if (a.cost < b.cost || (a.cost === b.cost && a.key < b.key)) bestIdx = i;
    }
    const current = frontier.splice(bestIdx, 1)[0]!;
    if (current.key === goal.key) {
      return compressLegs(current.path);
    }
    if ((best.get(current.key) ?? Infinity) < current.cost) continue;

    for (const edge of graph.adjacency.get(current.key) ?? []) {
      const stairs = current.stairs + edge.stairFloors;
      if (stairs > MAX_STAIR_FLOORS) continue;
      const cost = current.cost + edge.cost;
      if (cost < (best.get(edge.to) ?? Infinity)) {
        best.set(edge.to, cost);
        frontier.push({ key: edge.to, cost, stairs, path: [...current.path, edge] });
      }
    }
  }
  return null;
}

/** Merge consecutive edges on the same transport into single legs. */
function compressLegs(path: SegmentEdge[]): TripLeg[] {
  const legs: TripLeg[] = [];
  for (const edge of path) {
    const last = legs[legs.length - 1];
    if (last && last.transportId === edge.transport.id && last.toFloor === edge.fromFloor) {
      last.toFloor = edge.toFloor;
    } else {
      legs.push({
        kind: edge.kind,
        transportId: edge.transport.id,
        fromFloor: edge.fromFloor,
        toFloor: edge.toFloor,
      });
    }
  }
  return legs;
}
