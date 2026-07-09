/**
 * Tenants: lease-ups, move-outs, hotel bookings/checkouts, housekeeping, and
 * all trip generation (commuters, lunch rushes, residents, shoppers, guests).
 * Everything random goes through the seeded RNG in fixed iteration order.
 */
import { MAX_PEOPLE } from '../constants';
import { BALANCE, PARKING_SPACES_PER_ROOM, ROOM_CATALOG } from '../rooms/catalog';
import { rngChance, rngInt } from '../rng';
import type { Room, TowerState } from '../state';
import { credit } from './economy';
import { pushEvent, type SimEventList } from './events';
import type { Clock } from './time';
import { roomCenterX, spawnPerson } from './transport/movement';

function occupiedRooms(state: TowerState, pred: (r: Room) => boolean): Room[] {
  return state.rooms.filter((r) => r.occupied && r.reachable && pred(r));
}

function lobbySpawnX(state: TowerState, rngRoom: Room | null): number {
  const lobbies = state.rooms.filter((r) => r.type === 'lobby');
  if (lobbies.length === 0) return 0;
  const near = rngRoom ? roomCenterX(rngRoom) : undefined;
  let best = lobbies[0]!;
  if (near !== undefined) {
    let bestD = Infinity;
    for (const l of lobbies) {
      const d = Math.abs(roomCenterX(l) - near);
      if (d < bestD) {
        bestD = d;
        best = l;
      }
    }
  }
  return roomCenterX(best);
}

/** Parking factor 0..1: how well parked the tower is for its offices+retail. */
export function parkingFactor(state: TowerState): number {
  const spaces =
    state.rooms.filter((r) => r.type === 'parking' && r.reachable).length * PARKING_SPACES_PER_ROOM;
  const demand =
    state.rooms.filter((r) => (r.type === 'office' || ROOM_CATALOG[r.type].category === 'retail') && r.occupied).length * 2;
  if (demand === 0) return spaces > 0 ? 1 : 0;
  return Math.min(1, spaces / demand);
}

export function tenantsStep(state: TowerState, clock: Clock, events: SimEventList): void {
  const canSpawn = state.people.length < MAX_PEOPLE;

  // Leases and sales roll HOURLY through the day (not once at midnight), so a
  // freshly built tower comes to life while the player is still watching it.
  if (clock.minuteOfDay % 60 === 0) {
    hourlyLeases(state, clock, events);
  }
  if (clock.minuteOfDay === 0) {
    dailyMoveOuts(state, events);
  }

  if (canSpawn) {
    generateCommutes(state, clock);
    generateShoppers(state, clock);
  }

  if (clock.minuteOfDay === BALANCE.hotelCheckInHour * 60) {
    bookHotels(state, clock);
  }
  if (clock.minuteOfDay === BALANCE.hotelCheckOutHour * 60) {
    checkOutHotels(state, clock, events);
  }
  if (clock.minuteOfDay % 30 === 0 && clock.hour >= 9 && clock.hour < 17) {
    runHousekeeping(state);
  }
}

/** Vacant reachable offices/condos roll for tenants during business hours. */
function hourlyLeases(state: TowerState, clock: Clock, events: SimEventList): void {
  const park = parkingFactor(state);
  const demand = 0.8 + 0.1 * state.stars.rating;

  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];

    if (room.type === 'office' && !room.occupied && room.reachable) {
      if (clock.isWeekend || clock.hour < 8 || clock.hour > 17) continue;
      const p = BALANCE.officeLeaseChancePerHour * demand * (1 + BALANCE.parkingOfficeBonus * park);
      if (rngChance(state.rng, Math.min(0.5, p))) {
        room.occupied = true;
        room.occupants = def.people;
        room.satisfaction = Math.max(room.satisfaction, 60);
        pushEvent(events, { kind: 'moveIn', roomId: room.id, roomType: room.type });
        spawnMoveInBurst(state, clock, room, 'worker');
      }
    }

    if (room.type === 'condo' && !room.occupied && room.reachable) {
      if (clock.hour < 9 || clock.hour > 19) continue;
      if (rngChance(state.rng, BALANCE.condoSaleChancePerHour * demand)) {
        room.occupied = true;
        room.occupants = def.people;
        room.satisfaction = Math.max(room.satisfaction, 60);
        const price = def.salePrice ?? 0;
        credit(state, clock.day, 'Condo sold', price);
        pushEvent(events, { kind: 'condoSold', roomId: room.id, price });
        spawnMoveInBurst(state, clock, room, 'resident');
      }
    }
  }
}

/** New tenants arrive on foot right away — a tower should feel alive. */
function spawnMoveInBurst(state: TowerState, clock: Clock, room: Room, kind: 'worker' | 'resident'): void {
  if (state.people.length >= MAX_PEOPLE) return;
  const def = ROOM_CATALOG[room.type];
  for (let i = 0; i < def.people; i++) {
    const dwell =
      kind === 'worker'
        ? Math.max(45, 17 * 60 + rngInt(state.rng, 0, 90) - clock.minuteOfDay)
        : 120 + rngInt(state.rng, 0, 240);
    spawnPerson(state, {
      kind,
      fromX: lobbySpawnX(state, room),
      fromFloor: 0,
      targetRoom: room,
      homeRoomId: room.id,
      dwellMinutes: dwell,
      returnTo: kind === 'worker' ? 'ground' : null,
    });
  }
}

/** Once a day at midnight: unhappy tenants leave. */
function dailyMoveOuts(state: TowerState, events: SimEventList): void {
  for (const room of state.rooms) {
    if (room.type === 'office' && room.occupied && room.satisfaction < BALANCE.officeMoveOutBelow) {
      if (rngChance(state.rng, BALANCE.officeMoveOutChance)) {
        room.occupied = false;
        room.occupants = 0;
        pushEvent(events, { kind: 'moveOut', roomId: room.id, roomType: room.type, reason: 'unhappy tenants' });
      }
    }
    if (room.type === 'condo' && room.occupied && room.satisfaction < BALANCE.condoMoveOutBelow) {
      if (rngChance(state.rng, BALANCE.condoMoveOutChance)) {
        room.occupied = false;
        room.occupants = 0;
        pushEvent(events, { kind: 'moveOut', roomId: room.id, roomType: room.type, reason: 'residents left' });
      }
    }
  }
}

/** Office workers and condo residents commuting, plus office lunch traffic. */
function generateCommutes(state: TowerState, clock: Clock): void {
  const m = clock.minuteOfDay;
  const within = (h0: number, m0: number, h1: number, m1: number) =>
    m >= h0 * 60 + m0 && m < h1 * 60 + m1;

  if (!clock.isWeekend) {
    // Workers arrive 07:00–09:00 (~6 per office over 120 minutes).
    if (within(7, 0, 9, 0)) {
      for (const office of occupiedRooms(state, (r) => r.type === 'office')) {
        if (rngChance(state.rng, 6 / 120)) {
          spawnPerson(state, {
            kind: 'worker', fromX: lobbySpawnX(state, office), fromFloor: 0,
            targetRoom: office, homeRoomId: office.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
    // Lunch runs 11:30–13:30 to any open food retail (~2 per office).
    if (within(11, 30, 13, 30)) {
      const food = occupiedRooms(
        state,
        (r) => {
          const d = ROOM_CATALOG[r.type];
          return d.category === 'retail' && d.openHour !== undefined &&
            clock.hour >= d.openHour && clock.hour < (d.closeHour ?? 24);
        },
      );
      if (food.length > 0) {
        for (const office of occupiedRooms(state, (r) => r.type === 'office')) {
          if (rngChance(state.rng, 2 / 120)) {
            const target = food[rngInt(state.rng, 0, food.length)]!;
            spawnPerson(state, {
              kind: 'worker', fromX: roomCenterX(office), fromFloor: office.y,
              targetRoom: target, homeRoomId: office.id,
              dwellMinutes: 20 + rngInt(state.rng, 0, 20), returnTo: 'home',
            });
          }
        }
      }
    }
    // Workers leave 17:00–19:00.
    if (within(17, 0, 19, 0)) {
      for (const office of occupiedRooms(state, (r) => r.type === 'office')) {
        if (rngChance(state.rng, 6 / 120)) {
          spawnPerson(state, {
            kind: 'worker', fromX: roomCenterX(office), fromFloor: office.y,
            targetRoom: null, homeRoomId: office.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
    // Residents out 07:00–09:00, home 17:30–19:30 (~2 per condo).
    if (within(7, 0, 9, 0)) {
      for (const condo of occupiedRooms(state, (r) => r.type === 'condo')) {
        if (rngChance(state.rng, 2 / 120)) {
          spawnPerson(state, {
            kind: 'resident', fromX: roomCenterX(condo), fromFloor: condo.y,
            targetRoom: null, homeRoomId: condo.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
    if (within(17, 30, 19, 30)) {
      for (const condo of occupiedRooms(state, (r) => r.type === 'condo')) {
        if (rngChance(state.rng, 2 / 120)) {
          spawnPerson(state, {
            kind: 'resident', fromX: lobbySpawnX(state, condo), fromFloor: 0,
            targetRoom: condo, homeRoomId: condo.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
  } else {
    // Weekend: residents take one leisurely outing.
    if (within(10, 0, 12, 0)) {
      for (const condo of occupiedRooms(state, (r) => r.type === 'condo')) {
        if (rngChance(state.rng, 1 / 120)) {
          spawnPerson(state, {
            kind: 'resident', fromX: roomCenterX(condo), fromFloor: condo.y,
            targetRoom: null, homeRoomId: condo.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
    if (within(15, 0, 18, 0)) {
      for (const condo of occupiedRooms(state, (r) => r.type === 'condo')) {
        if (rngChance(state.rng, 1 / 180)) {
          spawnPerson(state, {
            kind: 'resident', fromX: lobbySpawnX(state, condo), fromFloor: 0,
            targetRoom: condo, homeRoomId: condo.id, dwellMinutes: 0, returnTo: null,
          });
        }
      }
    }
  }
}

/** Outside customers visiting retail during opening hours. */
function generateShoppers(state: TowerState, clock: Clock): void {
  const park = parkingFactor(state);
  const popFactor = Math.min(3, 0.5 + state.population / 1000);
  const weekend = clock.isWeekend ? BALANCE.weekendRetailBoost : 1;

  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];
    if (def.category !== 'retail' || !room.reachable || def.openHour === undefined) continue;
    if (clock.hour < def.openHour || clock.hour >= (def.closeHour ?? 24)) continue;
    const base = BALANCE.retailBaseRate[room.type] ?? 2;
    const satFactor = 0.4 + 0.6 * (room.satisfaction / 100);
    const perMinute =
      (base * popFactor * weekend * satFactor * (1 + (BALANCE.parkingRetailBoost - 1) * park)) / 60;
    if (rngChance(state.rng, Math.min(0.5, perMinute))) {
      spawnPerson(state, {
        kind: 'shopper', fromX: lobbySpawnX(state, room), fromFloor: 0,
        targetRoom: room, homeRoomId: null,
        dwellMinutes: 20 + rngInt(state.rng, 0, 20), returnTo: 'ground',
      });
    }
  }
}

/** 19:00: vacant clean reachable hotel rooms roll for tonight's guests. */
function bookHotels(state: TowerState, clock: Clock): void {
  const base = clock.isWeekend ? BALANCE.hotelBookWeekend : BALANCE.hotelBookWeekday;
  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];
    if (def.category !== 'hotel' || !room.hotel) continue;
    if (room.occupied || room.hotel.state !== 'vacant' || !room.reachable) continue;
    const satFactor = 0.4 + 0.6 * (room.satisfaction / 100);
    if (!rngChance(state.rng, base * satFactor)) continue;
    room.occupied = true; // booked; guests are now en route
    for (let i = 0; i < def.people; i++) {
      spawnPerson(state, {
        kind: 'guest', fromX: lobbySpawnX(state, room), fromFloor: 0,
        targetRoom: room, homeRoomId: room.id, dwellMinutes: 0, returnTo: null,
      });
    }
    // If nobody could route there, revert immediately.
    if (room.occupants === 0 && !state.people.some((p) => p.kind === 'guest' && p.targetRoomId === room.id)) {
      room.occupied = false;
    }
  }
}

/** 08:00: guests leave, nightly income lands, rooms become dirty. */
function checkOutHotels(state: TowerState, clock: Clock, events: SimEventList): void {
  let income = 0;
  let guests = 0;
  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];
    // Settle any room holding guests, even if the occupied flag was lost to a
    // mid-night inconsistency — checkout is the self-healing point.
    if (def.category !== 'hotel' || !room.hotel || (!room.occupied && room.occupants === 0)) continue;
    if (room.occupants > 0) {
      income += def.nightlyRate ?? 0;
      guests += room.occupants;
      for (let i = 0; i < room.occupants; i++) {
        spawnPerson(state, {
          kind: 'guest', fromX: roomCenterX(room), fromFloor: room.y,
          targetRoom: null, homeRoomId: room.id, dwellMinutes: 0, returnTo: null,
        });
      }
      room.hotel.state = 'dirty';
    } else {
      // Booked but nobody arrived (stranded guests): release the room.
      room.hotel.state = 'vacant';
    }
    room.occupied = false;
    room.occupants = 0;
  }
  if (income > 0) {
    credit(state, clock.day, 'Hotel nights', income);
    pushEvent(events, { kind: 'hotelNight', income, guests });
  }
}

/** Housekeeping cleans nearby dirty rooms during the day shift. */
function runHousekeeping(state: TowerState): void {
  for (const hk of state.rooms) {
    if (hk.type !== 'housekeeping' || !hk.reachable) continue;
    const done = hk.cleaningDone ?? 0;
    if (done >= BALANCE.housekeepingRoomsPerDay) continue;
    let best: Room | null = null;
    let bestDist = Infinity;
    for (const room of state.rooms) {
      if (!room.hotel || room.hotel.state !== 'dirty') continue;
      const dist = Math.abs(room.y - hk.y);
      if (dist <= BALANCE.housekeepingRadius && dist < bestDist) {
        best = room;
        bestDist = dist;
      }
    }
    if (best && best.hotel) {
      best.hotel.state = 'vacant';
      hk.cleaningDone = done + 1;
    }
  }
}
