/**
 * Elevator routing: collective-control / SCAN. A car keeps sweeping in its
 * current direction while stops (passenger destinations or hall calls) remain
 * ahead, then reverses. Hard invariants, enforced here and property-tested:
 * a car never exceeds capacity and never leaves its shaft's vertical range.
 *
 * Livelock safety: a hall call only counts as a stop for a car that could
 * actually board the caller right now (spare capacity, and travelling the
 * caller's way unless the car is empty). Every stop therefore makes progress
 * — unload, board, or both — so a car can never pin at a floor re-serving a
 * call it cannot take (the bug class where opposite-direction waiters or a
 * full car froze the whole shaft).
 *
 * The interface to the rest of the sim is intentionally small: cars read
 * people in the 'waitingElevator' phase and call onElevatorDropOff when they
 * deliver someone. Improving the algorithm later touches only this file.
 */
import {
  ELEVATOR_CAPACITY,
  ELEVATOR_SPEED_FLOORS_PER_MIN,
  ELEVATOR_STOP_MINUTES,
} from '../../constants';
import type { ElevatorCar, Person, TowerState, Transport } from '../../state';
import { onElevatorDropOff } from './movement';

function waitingFor(state: TowerState, shaft: Transport): Person[] {
  return state.people.filter(
    (p) => p.phase.kind === 'waitingElevator' && p.phase.transportId === shaft.id,
  );
}

function passengersOf(state: TowerState, car: ElevatorCar): Person[] {
  const out: Person[] = [];
  for (const id of car.passengerIds) {
    const p = state.people.find((pp) => pp.id === id);
    if (p) out.push(p);
  }
  return out;
}

function passengerTargets(state: TowerState, car: ElevatorCar): number[] {
  const out: number[] = [];
  for (const p of passengersOf(state, car)) {
    if (p.phase.kind === 'riding') out.push(p.phase.toFloor);
  }
  return out;
}

/**
 * Floors with a hall call this car could serve right now: never when full,
 * and a car carrying riders only answers calls along its sweep direction.
 * An empty car answers anything (it adopts its first boarder's direction).
 */
function serviceableCallFloors(state: TowerState, shaft: Transport, car: ElevatorCar): number[] {
  if (car.passengerIds.length >= ELEVATOR_CAPACITY) return [];
  const hasRiders = car.passengerIds.length > 0;
  const floors: number[] = [];
  for (const p of waitingFor(state, shaft)) {
    if (p.phase.kind !== 'waitingElevator') continue;
    const wantDir = Math.sign(p.phase.toFloor - p.floor);
    if (hasRiders && car.dir !== 0 && wantDir !== car.dir) continue;
    floors.push(p.floor);
  }
  return floors;
}

/** All floors where this car currently has a reason to stop. */
function stopFloors(state: TowerState, shaft: Transport, car: ElevatorCar): number[] {
  const floors = new Set<number>(passengerTargets(state, car));
  for (const f of serviceableCallFloors(state, shaft, car)) floors.add(f);
  return [...floors].sort((a, b) => a - b);
}

function nearestAhead(floors: number[], y: number, dir: 1 | -1): number | null {
  let best: number | null = null;
  for (const f of floors) {
    if ((f - y) * dir < -1e-9) continue;
    if (best === null || Math.abs(f - y) < Math.abs(best - y)) best = f;
  }
  return best;
}

function stopAtFloor(state: TowerState, shaft: Transport, car: ElevatorCar, floor: number): void {
  car.y = floor;
  car.stopTimer = ELEVATOR_STOP_MINUTES;

  // Unload.
  for (const p of passengersOf(state, car)) {
    if (p.phase.kind === 'riding' && p.phase.toFloor === floor) {
      car.passengerIds = car.passengerIds.filter((id) => id !== p.id);
      onElevatorDropOff(state, p, floor);
    }
  }

  // Direction after this stop: keep sweeping if anything remains ahead,
  // otherwise reverse toward remaining serviceable stops.
  const remaining = [...passengerTargets(state, car), ...serviceableCallFloors(state, shaft, car)];
  if (car.dir !== 0) {
    const ahead = remaining.some((f) => (f - floor) * car.dir > 0);
    const behind = remaining.some((f) => (f - floor) * car.dir < 0);
    if (!ahead && behind) car.dir = (car.dir * -1) as 1 | -1;
  }

  // Load: longest-waiting first; an empty car adopts its first rider's
  // direction, and everyone boarding must travel the car's direction.
  const waitingHere = waitingFor(state, shaft)
    .filter((p) => p.floor === floor)
    .sort((a, b) => {
      const wa = a.phase.kind === 'waitingElevator' ? a.phase.waitedMin : 0;
      const wb = b.phase.kind === 'waitingElevator' ? b.phase.waitedMin : 0;
      return wb - wa || a.id - b.id;
    });
  for (const p of waitingHere) {
    if (car.passengerIds.length >= ELEVATOR_CAPACITY) break;
    if (p.phase.kind !== 'waitingElevator') continue;
    const wantDir = Math.sign(p.phase.toFloor - floor) as 1 | -1 | 0;
    if (wantDir === 0) {
      // Degenerate leg (same floor) — complete it immediately.
      onElevatorDropOff(state, p, floor);
      continue;
    }
    if (car.passengerIds.length === 0 && passengerTargets(state, car).length === 0) {
      car.dir = wantDir;
    }
    if (wantDir !== car.dir) continue;
    car.passengerIds.push(p.id);
    p.phase = { kind: 'riding', transportId: shaft.id, carId: car.id, toFloor: p.phase.toFloor };
  }

  if (car.passengerIds.length === 0 && waitingFor(state, shaft).length === 0) {
    car.dir = 0;
  }
}

function stepCar(state: TowerState, shaft: Transport, car: ElevatorCar): void {
  if (car.stopTimer > 0) {
    car.stopTimer -= 1;
    return;
  }

  const stops = stopFloors(state, shaft, car);
  if (stops.length === 0) {
    car.dir = 0;
    // Idle cars drift back to the bottom landing so the next (usually
    // ground-floor) call is answered quickly.
    if (car.y > shaft.yMin) {
      car.y = Math.max(shaft.yMin, car.y - ELEVATOR_SPEED_FLOORS_PER_MIN);
    }
    return;
  }

  if (car.dir === 0) {
    // Idle: head for the nearest stop.
    let nearest = stops[0]!;
    for (const f of stops) if (Math.abs(f - car.y) < Math.abs(nearest - car.y)) nearest = f;
    if (Math.abs(nearest - car.y) < 1e-9) {
      stopAtFloor(state, shaft, car, nearest);
      return;
    }
    car.dir = nearest > car.y ? 1 : -1;
  }

  let next = nearestAhead(stops, car.y, car.dir as 1 | -1);
  if (next === null) {
    car.dir = (car.dir * -1) as 1 | -1;
    next = nearestAhead(stops, car.y, car.dir as 1 | -1);
    if (next === null) {
      car.dir = 0;
      return;
    }
  }

  const step = ELEVATOR_SPEED_FLOORS_PER_MIN;
  if (Math.abs(next - car.y) <= step + 1e-9) {
    stopAtFloor(state, shaft, car, next);
  } else {
    car.y += car.dir * step;
  }
  // Invariant: never leave the shaft.
  car.y = Math.min(shaft.yMax, Math.max(shaft.yMin, car.y));
}

export function stepElevators(state: TowerState): void {
  for (const shaft of state.transports) {
    if (shaft.type !== 'elevator' || !shaft.cars) continue;
    for (const car of shaft.cars) {
      stepCar(state, shaft, car);
    }
  }
}
