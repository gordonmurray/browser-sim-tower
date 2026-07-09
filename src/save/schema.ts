/**
 * Versioned persisted save format. The persisted shape is TowerState (already
 * plain JSON data) wrapped in an envelope carrying saveVersion. Any change to
 * the persisted shape requires a new version plus a migration in migrations.ts
 * — never mutate old saves in place.
 */
import type { TowerState } from '../core/state';

export const CURRENT_SAVE_VERSION = 1;

export interface SaveFileV1 {
  saveVersion: 1;
  /** Wall-clock ms when saved; display only, never used by the sim. */
  savedAt: number;
  state: TowerState;
}

export type CurrentSaveFile = SaveFileV1;

/** What we can assume about a save of unknown age. */
export interface UnknownSaveFile {
  saveVersion: number;
  [key: string]: unknown;
}
