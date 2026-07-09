/**
 * Economy: retail settles daily at midnight; rent and upkeep settle on
 * quarter boundaries. Construction costs are charged by the engine when
 * commands are applied; this module only handles recurring flows.
 */
import { DAYS_PER_QUARTER, LEDGER_LIMIT } from '../constants';
import { BALANCE, ROOM_CATALOG } from '../rooms/catalog';
import type { TowerState } from '../state';
import { pushEvent, type SimEventList } from './events';
import type { Clock } from './time';

export function credit(state: TowerState, day: number, label: string, amount: number): void {
  state.money += Math.round(amount);
  state.ledger.push({ day, label, amount: Math.round(amount) });
  if (state.ledger.length > LEDGER_LIMIT) {
    state.ledger = state.ledger.slice(state.ledger.length - LEDGER_LIMIT);
  }
}

export function economyStep(state: TowerState, clock: Clock, events: SimEventList): void {
  if (clock.minuteOfDay !== 0) return;

  // Daily: settle retail takings accrued from visits.
  let retailIncome = 0;
  let retailVisits = 0;
  for (const room of state.rooms) {
    if (!room.retail) continue;
    retailIncome += room.retail.incomeToday;
    retailVisits += room.retail.visitsToday;
    room.retail.incomeToday = 0;
    room.retail.visitsToday = 0;
  }
  if (retailIncome > 0) {
    credit(state, clock.day, 'Retail sales', retailIncome);
    pushEvent(events, { kind: 'retailDay', income: retailIncome, visits: retailVisits });
  }

  // Quarter boundary (midnight of every 8th day, after at least one quarter).
  if (clock.day > 0 && clock.day % DAYS_PER_QUARTER === 0) {
    settleQuarter(state, clock, events);
  }
}

function settleQuarter(state: TowerState, clock: Clock, events: SimEventList): void {
  let income = 0;
  let expenses = 0;

  for (const room of state.rooms) {
    const def = ROOM_CATALOG[room.type];
    if (def.rentPerQuarter && room.occupied && room.reachable) {
      income += def.rentPerQuarter;
    }
    if (def.upkeepPerQuarter) {
      expenses += def.upkeepPerQuarter;
    }
  }
  for (const t of state.transports) {
    if (t.type === 'elevator' && t.cars) {
      expenses += t.cars.length * BALANCE.elevatorUpkeepPerCarQuarter;
    }
    if (t.type === 'escalator') {
      expenses += BALANCE.escalatorUpkeepPerQuarter;
    }
  }

  const quarterIndex = clock.quarter; // the quarter that just began
  if (income > 0) credit(state, clock.day, `Q${quarterIndex} rent collected`, income);
  if (expenses > 0) credit(state, clock.day, `Q${quarterIndex} upkeep`, -expenses);
  pushEvent(events, { kind: 'quarter', quarterIndex, income, expenses, net: income - expenses });
}
