/**
 * Headless engine: the only entry points that mutate TowerState.
 * - applyCommand(): validates against the full rule set, then applies.
 * - tick(): advances the simulation one sim-minute in fixed system order.
 * The view layer (Phaser) issues commands and reads state; nothing else.
 */
import { ELEVATOR_SHAFT_WIDTH } from './constants';
import { addStructure, removeStructure } from './grid/grid';
import { BALANCE, ROOM_CATALOG } from './rooms/catalog';
import {
  extendElevatorAutoBuild,
  planElevatorAutoBuild,
  planFloorCells,
  validateAddCar,
  validateDemolish,
  validateElevatorPlacement,
  validateExtendElevator,
  validateFloorPlacement,
  validateRoomPlacement,
  validateStairlike,
  type FailureReason,
} from './rules/rules';
import {
  allocId,
  type Person,
  type Room,
  type RoomTypeId,
  type TowerState,
  type Transport,
} from './state';
import { economyStep, credit } from './sim/economy';
import { pushEvent, type SimEvent } from './sim/events';
import { populationStep } from './sim/population';
import { satisfactionStep } from './sim/satisfaction';
import { tenantsStep } from './sim/tenants';
import { clockOf } from './sim/time';
import { transportStep } from './sim/transport';
import { recomputeReachability } from './sim/transport/graph';
import { despawnPerson } from './sim/transport/movement';

export type Command =
  | { kind: 'PlaceRoom'; type: RoomTypeId; x: number; y: number }
  | { kind: 'PlaceFloor'; y: number; x0: number; x1: number }
  | { kind: 'PlaceStairs'; x: number; y: number }
  | { kind: 'PlaceEscalator'; x: number; y: number }
  | { kind: 'PlaceElevator'; x: number; yMin: number; yMax: number }
  | { kind: 'ExtendElevator'; transportId: number; yMin: number; yMax: number }
  | { kind: 'AddElevatorCar'; transportId: number }
  | { kind: 'Demolish'; x: number; y: number }
  | { kind: 'SetSpeed'; speed: 0 | 1 | 2 | 3 };

export type CommandResult =
  | { ok: true; cost: number }
  | { ok: false; reason: FailureReason };

export const STAIRLIKE_WIDTH = { stairs: 2, escalator: 4 } as const;

function structureChanged(state: TowerState): void {
  state.structureVersion += 1;
  state.reachabilityDirty = false;
  recomputeReachability(state); // immediate, so the UI is honest while paused
}

function chargeBuild(state: TowerState, label: string, cost: number): void {
  if (cost !== 0) credit(state, clockOf(state.minutes).day, label, -cost);
}

export function applyCommand(state: TowerState, cmd: Command): CommandResult {
  switch (cmd.kind) {
    case 'PlaceRoom': {
      const v = validateRoomPlacement(state, cmd.type, cmd.x, cmd.y);
      if (!v.ok) return v;
      const def = ROOM_CATALOG[cmd.type];
      addStructure(state, cmd.y, cmd.x, cmd.x + def.w - 1);
      const alwaysOccupied = ['lobby', 'retail', 'support', 'parking'].includes(def.category);
      const room: Room = {
        id: allocId(state),
        type: cmd.type,
        x: cmd.x,
        y: cmd.y,
        w: def.w,
        h: def.h,
        occupied: alwaysOccupied,
        occupants: 0,
        satisfaction: 70,
        reachable: false,
        waitSamples: 0,
        waitTotal: 0,
        avgWait: 0,
        noisePenalty: 0,
      };
      if (def.category === 'hotel') room.hotel = { state: 'vacant' };
      if (def.category === 'retail') room.retail = { visitsToday: 0, incomeToday: 0 };
      if (cmd.type === 'housekeeping') room.cleaningDone = 0;
      state.rooms.push(room);
      chargeBuild(state, `Built ${def.name}`, v.cost);
      structureChanged(state);
      return { ok: true, cost: v.cost };
    }

    case 'PlaceFloor': {
      const v = validateFloorPlacement(state, cmd.y, cmd.x0, cmd.x1);
      if (!v.ok) return v;
      // Partial placement: only the buildable cells of the drag are added.
      for (const seg of planFloorCells(state, cmd.y, cmd.x0, cmd.x1).segments) {
        addStructure(state, cmd.y, seg.x0, seg.x1);
      }
      chargeBuild(state, 'Built floor', v.cost);
      structureChanged(state);
      return { ok: true, cost: v.cost };
    }

    case 'PlaceStairs':
    case 'PlaceEscalator': {
      const kind = cmd.kind === 'PlaceStairs' ? 'stairs' : 'escalator';
      const w = STAIRLIKE_WIDTH[kind];
      const v = validateStairlike(state, kind, cmd.x, cmd.y, w);
      if (!v.ok) return v;
      addStructure(state, cmd.y, cmd.x, cmd.x + w - 1);
      addStructure(state, cmd.y + 1, cmd.x, cmd.x + w - 1);
      const transport: Transport = {
        id: allocId(state),
        type: kind,
        x: cmd.x,
        w,
        yMin: cmd.y,
        yMax: cmd.y + 1,
      };
      state.transports.push(transport);
      chargeBuild(state, kind === 'stairs' ? 'Built stairs' : 'Built escalator', v.cost);
      structureChanged(state);
      return { ok: true, cost: v.cost };
    }

    case 'PlaceElevator': {
      const v = validateElevatorPlacement(state, cmd.x, cmd.yMin, cmd.yMax);
      if (!v.ok) return v;
      // Landings: build the shaft's footprint through existing construction
      // (skipping open-sky rows) so served floors connect without busywork.
      for (const run of planElevatorAutoBuild(state, cmd.x, cmd.yMin, cmd.yMax)) {
        addStructure(state, run.y, run.x0, run.x1);
      }
      const transport: Transport = {
        id: allocId(state),
        type: 'elevator',
        x: cmd.x,
        w: ELEVATOR_SHAFT_WIDTH,
        yMin: cmd.yMin,
        yMax: cmd.yMax,
        cars: [],
      };
      for (let i = 0; i < BALANCE.elevatorCarsIncluded; i++) {
        transport.cars!.push({
          id: allocId(state),
          y: cmd.yMin,
          dir: 0,
          passengerIds: [],
          stopTimer: 0,
        });
      }
      state.transports.push(transport);
      chargeBuild(state, 'Built elevator', v.cost);
      structureChanged(state);
      return { ok: true, cost: v.cost };
    }

    case 'ExtendElevator': {
      const shaft = state.transports.find((t) => t.id === cmd.transportId);
      if (!shaft) return { ok: false, reason: 'not-an-elevator' };
      const v = validateExtendElevator(state, shaft, cmd.yMin, cmd.yMax);
      if (!v.ok) return v;
      for (const run of extendElevatorAutoBuild(state, shaft, cmd.yMin, cmd.yMax)) {
        addStructure(state, run.y, run.x0, run.x1);
      }
      shaft.yMin = cmd.yMin;
      shaft.yMax = cmd.yMax;
      chargeBuild(state, 'Extended elevator', v.cost);
      structureChanged(state);
      return { ok: true, cost: v.cost };
    }

    case 'AddElevatorCar': {
      const shaft = state.transports.find((t) => t.id === cmd.transportId);
      if (!shaft) return { ok: false, reason: 'not-an-elevator' };
      const v = validateAddCar(state, shaft);
      if (!v.ok) return v;
      shaft.cars!.push({ id: allocId(state), y: shaft.yMin, dir: 0, passengerIds: [], stopTimer: 0 });
      chargeBuild(state, 'Added elevator car', v.cost);
      return { ok: true, cost: v.cost };
    }

    case 'Demolish': {
      const v = validateDemolish(state, cmd.x, cmd.y);
      if (!v.ok) return v;
      const target = v.target;
      if (target.kind === 'room') {
        const room = state.rooms.find((r) => r.id === target.roomId)!;
        despawnPeople(state, (p) => p.homeRoomId === room.id || p.targetRoomId === room.id);
        state.rooms = state.rooms.filter((r) => r.id !== room.id);
      } else if (target.kind === 'transport') {
        const transport = state.transports.find((t) => t.id === target.transportId)!;
        despawnPeople(state, (p) => personUsesTransport(p, transport.id));
        state.transports = state.transports.filter((t) => t.id !== transport.id);
      } else {
        removeStructure(state, target.y, target.x, target.x);
      }
      structureChanged(state);
      return { ok: true, cost: 0 };
    }

    case 'SetSpeed': {
      state.speed = cmd.speed;
      return { ok: true, cost: 0 };
    }
  }
}

function personUsesTransport(p: Person, transportId: number): boolean {
  const phase = p.phase;
  if (
    (phase.kind === 'waitingElevator' || phase.kind === 'riding' || phase.kind === 'traversing') &&
    phase.transportId === transportId
  ) {
    return true;
  }
  for (let i = p.legIndex; i < p.legs.length; i++) {
    if (p.legs[i]!.transportId === transportId) return true;
  }
  return false;
}

function despawnPeople(state: TowerState, pred: (p: Person) => boolean): void {
  const doomed = state.people.filter(pred);
  for (const p of doomed) despawnPerson(state, p);
}

/** Advance the simulation by exactly one sim-minute. */
export function tick(state: TowerState): SimEvent[] {
  state.minutes += 1;
  const clock = clockOf(state.minutes);
  const events: SimEvent[] = [];
  if (clock.minuteOfDay === 0) pushEvent(events, { kind: 'day', day: clock.day });

  tenantsStep(state, clock, events);
  transportStep(state);
  satisfactionStep(state, clock);
  economyStep(state, clock, events);
  populationStep(state, events);

  return events;
}
