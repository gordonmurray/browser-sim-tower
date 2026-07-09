/**
 * TowerState: the entire simulation as plain JSON-serialisable data.
 * No classes, no Maps, no functions — arrays and plain objects only, so the
 * save layer can serialise it directly and round-trips are exact.
 */
import { createRng, type RngState } from './rng';

export type RoomTypeId =
  | 'lobby'
  | 'office'
  | 'condo'
  | 'fastfood'
  | 'shop'
  | 'restaurant'
  | 'hotelSingle'
  | 'hotelDouble'
  | 'hotelSuite'
  | 'housekeeping'
  | 'security'
  | 'medical'
  | 'recycling'
  | 'parking';

export type TransportTypeId = 'stairs' | 'escalator' | 'elevator';

/** Inclusive horizontal run of built structure cells on one floor. */
export interface FloorRun {
  x0: number;
  x1: number;
}

/** Structure for one floor; runs are sorted by x0, disjoint and merged. */
export interface FloorStructure {
  y: number;
  runs: FloorRun[];
}

export type HotelRoomState = 'vacant' | 'occupied' | 'dirty';

export interface Room {
  id: number;
  type: RoomTypeId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Leased (office) / sold (condo) / booked (hotel). Lobby, retail, support: true. */
  occupied: boolean;
  /** People counted toward population for this room (workers, residents, guests). */
  occupants: number;
  satisfaction: number; // 0..100
  reachable: boolean;
  hotel?: { state: HotelRoomState };
  retail?: { visitsToday: number; incomeToday: number };
  /** Housekeeping: rooms cleaned so far today. */
  cleaningDone?: number;
  /** Elevator wait stats: accumulated during the day, folded into avgWait at rollover. */
  waitSamples: number;
  waitTotal: number;
  avgWait: number;
  noisePenalty: number;
}

export interface ElevatorCar {
  id: number;
  /** Vertical position in floors (float while moving). */
  y: number;
  dir: -1 | 0 | 1;
  passengerIds: number[];
  /** Minutes remaining stopped at a floor for load/unload. */
  stopTimer: number;
}

export interface Transport {
  id: number;
  type: TransportTypeId;
  x: number;
  w: number;
  yMin: number;
  yMax: number; // stairs/escalator: yMax === yMin + 1
  cars?: ElevatorCar[];
}

export type PersonKind = 'worker' | 'resident' | 'guest' | 'shopper';

export type LegKind = 'elevator' | 'stairs' | 'escalator';

export interface TripLeg {
  kind: LegKind;
  transportId: number;
  fromFloor: number;
  toFloor: number;
}

export type PersonPhase =
  | { kind: 'walking'; minutesLeft: number }
  | { kind: 'traversing'; transportId: number; toFloor: number; minutesLeft: number }
  | { kind: 'waitingElevator'; transportId: number; toFloor: number; waitedMin: number }
  | { kind: 'riding'; transportId: number; carId: number; toFloor: number }
  | { kind: 'dwelling'; minutesLeft: number };

export interface Person {
  id: number;
  kind: PersonKind;
  /** Room this person belongs to (office/condo/hotel). */
  homeRoomId: number | null;
  /** Room the current trip targets. null = heading to a ground lobby / exit. */
  targetRoomId: number | null;
  floor: number;
  x: number;
  targetX: number;
  legs: TripLeg[];
  legIndex: number;
  phase: PersonPhase;
  /** Minutes to dwell at the target before the next move (0 = finish there). */
  dwellMinutes: number;
  /** After dwelling: head back to ground, back home, or just despawn. */
  returnTo: 'ground' | 'home' | null;
  /** Elevator wait accumulated since the last attribution. */
  totalWait: number;
}

export interface StarState {
  rating: 1 | 2 | 3 | 4 | 5;
}

export interface LedgerEntry {
  day: number;
  label: string;
  amount: number;
}

export interface DailyStats {
  trips: number;
  totalWait: number;
  maxWait: number;
  giveUps: number;
}

export interface TowerState {
  rng: RngState;
  /** Total sim-minutes since the tower was founded. */
  minutes: number;
  speed: 0 | 1 | 2 | 3;
  money: number;
  stars: StarState;
  structure: FloorStructure[]; // sorted by y ascending
  rooms: Room[];
  transports: Transport[];
  people: Person[];
  nextId: number;
  population: number;
  ledger: LedgerEntry[];
  /** Bumped on any placement/demolition; invalidates cached transport graphs. */
  structureVersion: number;
  reachabilityDirty: boolean;
  dailyStats: DailyStats;
}

export function createInitialState(seed: number, startingMoney: number): TowerState {
  return {
    rng: createRng(seed),
    minutes: 7 * 60, // day 0, 07:00 — the morning of opening day
    speed: 1,
    money: startingMoney,
    stars: { rating: 1 },
    structure: [],
    rooms: [],
    transports: [],
    people: [],
    nextId: 1,
    population: 0,
    ledger: [],
    structureVersion: 0,
    reachabilityDirty: true,
    dailyStats: { trips: 0, totalWait: 0, maxWait: 0, giveUps: 0 },
  };
}

export function allocId(state: TowerState): number {
  return state.nextId++;
}
