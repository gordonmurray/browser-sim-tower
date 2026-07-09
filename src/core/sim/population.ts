/**
 * Population and star rating. Population is the sum of room occupants
 * (workers, residents, tonight's hotel guests). Stars only ever go up.
 */
import { ROOM_CATALOG, STAR_THRESHOLDS } from '../rooms/catalog';
import type { RoomTypeId, TowerState } from '../state';
import { pushEvent, type SimEventList } from './events';

export function populationStep(state: TowerState, events: SimEventList): void {
  let population = 0;
  for (const room of state.rooms) {
    population += room.occupants;
  }
  state.population = population;

  let target: 1 | 2 | 3 | 4 | 5 = 1;
  for (let i = STAR_THRESHOLDS.length - 1; i >= 0; i--) {
    if (population >= STAR_THRESHOLDS[i]!) {
      target = (i + 1) as 1 | 2 | 3 | 4 | 5;
      break;
    }
  }
  if (target > state.stars.rating) {
    state.stars.rating = target;
    const unlocked = (Object.keys(ROOM_CATALOG) as RoomTypeId[]).filter(
      (id) => ROOM_CATALOG[id].starRequired === target,
    );
    pushEvent(events, { kind: 'starUp', rating: target, unlocked });
  }
}
