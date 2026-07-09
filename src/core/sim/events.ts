/**
 * Transient events emitted by ticks and commands. They are not part of
 * TowerState (never persisted); the UI consumes them for toasts and sounds.
 */
import type { RoomTypeId } from '../state';

export type SimEvent =
  | { kind: 'day'; day: number }
  | { kind: 'quarter'; quarterIndex: number; income: number; expenses: number; net: number }
  | { kind: 'starUp'; rating: number; unlocked: RoomTypeId[] }
  | { kind: 'moveIn'; roomId: number; roomType: RoomTypeId }
  | { kind: 'moveOut'; roomId: number; roomType: RoomTypeId; reason: string }
  | { kind: 'condoSold'; roomId: number; price: number }
  | { kind: 'hotelNight'; income: number; guests: number }
  | { kind: 'retailDay'; income: number; visits: number };

export type SimEventList = SimEvent[];

export function pushEvent(list: SimEventList, event: SimEvent): void {
  list.push(event);
}
