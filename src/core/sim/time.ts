/**
 * Sim clock helpers. Time is a single monotonic minute counter on state;
 * everything else (day, hour, weekday, quarter) derives from it.
 */
import { DAYS_PER_QUARTER, MINUTES_PER_DAY } from '../constants';

export interface Clock {
  day: number;
  minuteOfDay: number;
  hour: number;
  minute: number;
  dayOfWeek: number; // 0..6, 5 and 6 are the weekend
  isWeekend: boolean;
  quarter: number;
  isNight: boolean;
}

export function clockOf(minutes: number): Clock {
  const day = Math.floor(minutes / MINUTES_PER_DAY);
  const minuteOfDay = minutes % MINUTES_PER_DAY;
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const dayOfWeek = day % 7;
  return {
    day,
    minuteOfDay,
    hour,
    minute,
    dayOfWeek,
    isWeekend: dayOfWeek >= 5,
    quarter: Math.floor(day / DAYS_PER_QUARTER),
    isNight: hour < 6 || hour >= 20,
  };
}

export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatClock(minutes: number): string {
  const c = clockOf(minutes);
  const hh = String(c.hour).padStart(2, '0');
  const mm = String(c.minute).padStart(2, '0');
  return `Day ${c.day + 1} (${WEEKDAY_NAMES[c.dayOfWeek]}) ${hh}:${mm}`;
}
