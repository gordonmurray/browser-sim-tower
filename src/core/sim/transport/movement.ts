/**
 * Person lifecycle and movement: spawning, walking between waypoints,
 * traversing stairs/escalators, waiting for and riding elevators, dwelling,
 * arrival effects and despawning. Elevator cars themselves are stepped in
 * elevators.ts; this module handles everything people do around them.
 */
import {
  ESCALATOR_MINUTES_PER_FLOOR,
  GIVE_UP_WAIT_MINUTES,
  STAIR_MINUTES_PER_FLOOR,
  WALK_CELLS_PER_MIN,
} from '../../constants';
import { ROOM_CATALOG } from '../../rooms/catalog';
import {
  allocId,
  type Person,
  type PersonKind,
  type Room,
  type TowerState,
  type TripLeg,
} from '../../state';
import { planTrip } from './graph';

export function roomCenterX(room: Room): number {
  return room.x + Math.floor(room.w / 2);
}

export function findRoom(state: TowerState, id: number | null): Room | undefined {
  if (id === null) return undefined;
  return state.rooms.find((r) => r.id === id);
}

function walkMinutes(fromX: number, toX: number): number {
  return Math.max(0.2, Math.abs(toX - fromX) / WALK_CELLS_PER_MIN);
}

/** Pick a lobby to enter/exit through; null if the tower has none. */
export function pickLobby(state: TowerState, preferNearX?: number): Room | null {
  const lobbies = state.rooms.filter((r) => r.type === 'lobby');
  if (lobbies.length === 0) return null;
  if (preferNearX === undefined) return lobbies[0]!;
  let best = lobbies[0]!;
  let bestDist = Infinity;
  for (const lobby of lobbies) {
    const d = Math.abs(roomCenterX(lobby) - preferNearX);
    if (d < bestDist) {
      bestDist = d;
      best = lobby;
    }
  }
  return best;
}

export interface SpawnSpec {
  kind: PersonKind;
  fromX: number;
  fromFloor: number;
  /** Destination room; null means "a ground-floor lobby". */
  targetRoom: Room | null;
  homeRoomId: number | null;
  dwellMinutes: number;
  returnTo: 'ground' | 'home' | null;
}

/** Spawn a person and plan their trip. Returns null if there is no route. */
export function spawnPerson(state: TowerState, spec: SpawnSpec): Person | null {
  let toX: number;
  let toFloor: number;
  if (spec.targetRoom) {
    toX = roomCenterX(spec.targetRoom);
    toFloor = spec.targetRoom.y;
  } else {
    const lobby = pickLobby(state, spec.fromX);
    if (!lobby) return null;
    toX = roomCenterX(lobby);
    toFloor = 0;
  }
  const legs = planTrip(state, spec.fromX, spec.fromFloor, toX, toFloor);
  if (legs === null) return null;

  const person: Person = {
    id: allocId(state),
    kind: spec.kind,
    homeRoomId: spec.homeRoomId,
    targetRoomId: spec.targetRoom ? spec.targetRoom.id : null,
    floor: spec.fromFloor,
    x: spec.fromX,
    targetX: toX,
    legs,
    legIndex: 0,
    phase: { kind: 'walking', minutesLeft: 0 },
    dwellMinutes: spec.dwellMinutes,
    returnTo: spec.returnTo,
    totalWait: 0,
  };
  startWalkToNextWaypoint(state, person, toX);
  state.people.push(person);
  state.dailyStats.trips += 1;
  return person;
}

/** Record elevator-wait pain against a room (drives satisfaction). */
export function recordWait(state: TowerState, roomId: number | null, minutes: number): void {
  state.dailyStats.totalWait += minutes;
  state.dailyStats.maxWait = Math.max(state.dailyStats.maxWait, minutes);
  const room = findRoom(state, roomId);
  if (!room) return;
  room.waitSamples += 1;
  room.waitTotal += minutes;
}

function attributionRoomId(person: Person): number | null {
  return person.homeRoomId ?? person.targetRoomId;
}

/**
 * Remove a person. Consistently reverts a pending hotel booking when an
 * inbound guest never made it, and attributes any un-recorded wait.
 */
export function despawnPerson(state: TowerState, person: Person, opts?: { gaveUp?: boolean }): void {
  if (person.totalWait > 0) {
    recordWait(state, attributionRoomId(person), person.totalWait);
    person.totalWait = 0;
  }
  if (opts?.gaveUp) state.dailyStats.giveUps += 1;
  if (person.kind === 'guest' && person.targetRoomId !== null) {
    const room = findRoom(state, person.targetRoomId);
    // Revert the booking only when this was the LAST inbound guest: a
    // co-guest still en route (doubles/suites spawn several) must not find
    // the booking gone, or the room ends up occupied-but-unbookable forever.
    const othersInbound = state.people.some(
      (p) => p.id !== person.id && p.kind === 'guest' && p.targetRoomId === person.targetRoomId,
    );
    if (room && room.hotel && room.occupants === 0 && room.hotel.state === 'vacant' && !othersInbound) {
      room.occupied = false; // booking reverted, room bookable again
    }
  }
  const car = person.phase.kind === 'riding' ? findCar(state, person.phase.transportId, person.phase.carId) : null;
  if (car) car.passengerIds = car.passengerIds.filter((id) => id !== person.id);
  state.people = state.people.filter((p) => p.id !== person.id);
}

function findCar(state: TowerState, transportId: number, carId: number) {
  const t = state.transports.find((tr) => tr.id === transportId);
  return t?.cars?.find((c) => c.id === carId) ?? null;
}

/**
 * Set the person walking toward the next waypoint: the boarding point of the
 * next leg, or finalX if no legs remain.
 */
export function startWalkToNextWaypoint(state: TowerState, person: Person, finalX: number): void {
  const leg = person.legs[person.legIndex];
  let toX = finalX;
  if (leg) {
    const t = state.transports.find((tr) => tr.id === leg.transportId);
    if (t) toX = t.x + Math.floor(t.w / 2);
  }
  person.targetX = toX;
  person.phase = { kind: 'walking', minutesLeft: walkMinutes(person.x, toX) };
}

/** Begin the leg the person has just walked to. */
function beginLeg(state: TowerState, person: Person, leg: TripLeg): void {
  if (leg.kind === 'elevator') {
    person.phase = { kind: 'waitingElevator', transportId: leg.transportId, toFloor: leg.toFloor, waitedMin: 0 };
  } else {
    const perFloor = leg.kind === 'stairs' ? STAIR_MINUTES_PER_FLOOR : ESCALATOR_MINUTES_PER_FLOOR;
    const minutes = Math.abs(leg.toFloor - leg.fromFloor) * perFloor;
    person.phase = { kind: 'traversing', transportId: leg.transportId, toFloor: leg.toFloor, minutesLeft: minutes };
  }
}

/** Where this person is ultimately walking to on their destination floor. */
function finalX(state: TowerState, person: Person): number {
  const target = findRoom(state, person.targetRoomId);
  if (target) return roomCenterX(target);
  const lobby = pickLobby(state, person.x);
  return lobby ? roomCenterX(lobby) : person.x;
}

/** Trip finished (arrived at targetX on the destination floor). */
function handleArrival(state: TowerState, person: Person): void {
  // Attribute the outbound wait now so satisfaction reacts the same day.
  if (person.totalWait > 0) {
    recordWait(state, attributionRoomId(person), person.totalWait);
    person.totalWait = 0;
  }

  const target = findRoom(state, person.targetRoomId);
  if (target) {
    applyArrivalEffects(state, person, target);
  }

  if (person.dwellMinutes > 0) {
    person.phase = { kind: 'dwelling', minutesLeft: person.dwellMinutes };
    person.dwellMinutes = 0;
    return;
  }
  despawnPerson(state, person);
}

function applyArrivalEffects(state: TowerState, person: Person, target: Room): void {
  const def = ROOM_CATALOG[target.type];
  if (person.kind === 'guest' && target.hotel) {
    target.occupants += 1;
    target.hotel.state = 'occupied';
    // Self-heal: if the booking was reverted while this guest was en route,
    // restore it so checkout settles the room normally.
    target.occupied = true;
    return;
  }
  if (def.category === 'retail' && target.retail && def.incomePerVisit) {
    target.retail.visitsToday += 1;
    target.retail.incomeToday += def.incomePerVisit;
  }
}

/** Dwell finished: plan the follow-up trip (or leave the stage). */
function handleDwellEnd(state: TowerState, person: Person): void {
  if (person.returnTo === null) {
    despawnPerson(state, person);
    return;
  }
  const home = findRoom(state, person.homeRoomId);
  const targetRoom = person.returnTo === 'home' ? (home ?? null) : null;
  if (person.returnTo === 'home' && !targetRoom) {
    despawnPerson(state, person);
    return;
  }
  let toX: number;
  let toFloor: number;
  if (targetRoom) {
    toX = roomCenterX(targetRoom);
    toFloor = targetRoom.y;
  } else {
    const lobby = pickLobby(state, person.x);
    if (!lobby) {
      despawnPerson(state, person);
      return;
    }
    toX = roomCenterX(lobby);
    toFloor = 0;
  }
  const legs = planTrip(state, person.x, person.floor, toX, toFloor);
  if (legs === null) {
    despawnPerson(state, person);
    return;
  }
  person.targetRoomId = targetRoom ? targetRoom.id : null;
  person.legs = legs;
  person.legIndex = 0;
  person.returnTo = null;
  startWalkToNextWaypoint(state, person, toX);
}

/** Advance every person by one sim-minute. Elevator riders are moved by cars. */
export function stepPeople(state: TowerState): void {
  // Iterate over a snapshot: despawns mutate state.people.
  const snapshot = [...state.people];
  for (const person of snapshot) {
    if (!state.people.includes(person)) continue;
    const phase = person.phase;
    switch (phase.kind) {
      case 'walking': {
        moveHorizontally(person);
        phase.minutesLeft -= 1;
        if (phase.minutesLeft <= 0) {
          person.x = person.targetX;
          const leg = person.legs[person.legIndex];
          if (leg) {
            beginLeg(state, person, leg);
          } else {
            handleArrival(state, person);
          }
        }
        break;
      }
      case 'traversing': {
        phase.minutesLeft -= 1;
        if (phase.minutesLeft <= 0) {
          person.floor = phase.toFloor;
          person.legIndex += 1;
          startWalkToNextWaypoint(state, person, finalX(state, person));
        }
        break;
      }
      case 'waitingElevator': {
        phase.waitedMin += 1;
        person.totalWait += 1;
        if (phase.waitedMin >= GIVE_UP_WAIT_MINUTES) {
          despawnPerson(state, person, { gaveUp: true });
        }
        break;
      }
      case 'riding':
        break; // the car carries them
      case 'dwelling': {
        phase.minutesLeft -= 1;
        if (phase.minutesLeft <= 0) handleDwellEnd(state, person);
        break;
      }
    }
  }
}

function moveHorizontally(person: Person): void {
  const dx = person.targetX - person.x;
  const step = Math.sign(dx) * Math.min(Math.abs(dx), WALK_CELLS_PER_MIN);
  person.x += step;
}

/**
 * Called by the elevator system when a passenger is dropped at a floor:
 * advance to the next leg or walk to the final destination.
 */
export function onElevatorDropOff(state: TowerState, person: Person, floor: number): void {
  person.floor = floor;
  person.legIndex += 1;
  startWalkToNextWaypoint(state, person, finalX(state, person));
}
