/**
 * Cell metrics, colors and small color helpers. One place to retheme the
 * whole tower. Interiors use deterministic per-room variants via hashU.
 */
import { MAX_FLOOR } from '../../core/constants';
import type { PersonKind, RoomTypeId } from '../../core/state';

export const CELL_W = 16;
export const CELL_H = 36;

export function cellLeft(x: number): number {
  return x * CELL_W;
}

/** World-Y of the TOP of floor y (screen Y grows downward, floors grow up). */
export function floorTop(y: number): number {
  return (MAX_FLOOR - y) * CELL_H;
}

export function worldToCell(wx: number, wy: number): { x: number; y: number } {
  return { x: Math.floor(wx / CELL_W), y: MAX_FLOOR - Math.floor(wy / CELL_H) };
}

/** Deterministic 0..1 hash for per-room visual variety (never sim-relevant). */
export function hashU(a: number, b = 0): number {
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const COLORS = {
  // Building shell
  structure: 0x363c49,
  structureDark: 0x2b303c,
  structureEdge: 0x1b1f28,
  girder: 0x4d5568,
  slab: 0x515a6c,
  roof: 0x39404e,
  earthTop: 0x2e2418,
  earthDeep: 0x1c150d,
  groundGrass: 0x3f5a33,
  pavement: 0x555b66,
  road: 0x30343c,

  room: {
    lobby: 0xd8b25f,
    office: 0x5b93d8,
    condo: 0x7cc47c,
    fastfood: 0xe08348,
    shop: 0xc276cf,
    restaurant: 0xd65f79,
    hotelSingle: 0xa8896a,
    hotelDouble: 0xb6926e,
    hotelSuite: 0xd2a878,
    housekeeping: 0x93a7b3,
    security: 0x5f7d8c,
    medical: 0xe0e6ea,
    recycling: 0x6fb371,
    parking: 0x62656e,
  } as Record<RoomTypeId, number>,

  vacantDim: 0.45,
  unreachable: 0xff5544,
  dirtyHotel: 0x8a6a48,
  windowLit: 0xffd98a,
  windowDark: 0x1b2230,
  nightVeil: 0x0a1226,

  elevatorShaft: 0x181c26,
  elevatorRail: 0x39404e,
  elevatorBrace: 0x272d3a,
  elevatorCar: 0xf4c542,
  elevatorCarLit: 0xffe9b0,
  elevatorDoor: 0x8e97ab,
  stairs: 0x8fa0b5,
  escalator: 0x7fc97f,

  person: {
    worker: 0xdde3f0,
    resident: 0xa8e0a8,
    guest: 0xf0d8a0,
    shopper: 0xd0b0f0,
  } as Record<PersonKind, number>,
  personImpatient: 0xff7060,

  ghostOk: 0x44dd88,
  ghostBad: 0xee4444,
  selection: 0xffffff,
} as const;

export function dimColor(color: number, factor: number): number {
  const r = Math.floor(((color >> 16) & 0xff) * factor);
  const g = Math.floor(((color >> 8) & 0xff) * factor);
  const b = Math.floor((color & 0xff) * factor);
  return (r << 16) | (g << 8) | b;
}

/** Linear blend a→b by t in 0..1. */
export function mixColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function brighten(color: number, amount: number): number {
  return mixColor(color, 0xffffff, amount);
}

/** Green→red by satisfaction 100→0. */
export function satisfactionColor(sat: number): number {
  const t = Math.max(0, Math.min(1, sat / 100));
  const r = Math.floor(0xee * (1 - t) + 0x33 * t);
  const g = Math.floor(0x44 * (1 - t) + 0xcc * t);
  return (r << 16) | (g << 8) | 0x44;
}
