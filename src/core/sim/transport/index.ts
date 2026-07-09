/**
 * Transport step: reachability, people movement, elevator cars — in that
 * order, so people plan against up-to-date reachability.
 */
import type { TowerState } from '../../state';
import { stepElevators } from './elevators';
import { recomputeReachability } from './graph';
import { stepPeople } from './movement';

export function transportStep(state: TowerState): void {
  if (state.reachabilityDirty) {
    recomputeReachability(state);
    state.reachabilityDirty = false;
  }
  stepPeople(state);
  stepElevators(state);
}
