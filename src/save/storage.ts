/**
 * localStorage persistence. Loads always run the migration chain; saves are
 * written deliberately (day boundaries / throttle / user action), never every
 * tick. Also provides export/import as a JSON string for backup files.
 */
import type { TowerState } from '../core/state';
import { migrateToCurrent, SaveError } from './migrations';
import { CURRENT_SAVE_VERSION, type CurrentSaveFile } from './schema';

export const SAVE_KEY = 'browser-sim-tower.save';

export function serialize(state: TowerState, savedAt: number): string {
  const file: CurrentSaveFile = { saveVersion: CURRENT_SAVE_VERSION, savedAt, state };
  return JSON.stringify(file);
}

/**
 * Shallow shape check on the migrated payload. Guards against truncated or
 * hand-edited files whose envelope parses but whose state is missing or
 * garbage — without this, an import could replace live state with undefined
 * and the next autosave would destroy the player's good save.
 */
function assertValidState(s: unknown): asserts s is TowerState {
  const bad = (): never => {
    throw new SaveError('Save file has no valid tower state.');
  };
  if (typeof s !== 'object' || s === null) bad();
  const st = s as Record<string, unknown>;
  if (typeof st.minutes !== 'number' || !Number.isFinite(st.minutes)) bad();
  if (typeof st.money !== 'number' || !Number.isFinite(st.money)) bad();
  if (typeof st.nextId !== 'number') bad();
  if (typeof (st.rng as { s?: unknown } | null)?.s !== 'number') bad();
  if (typeof (st.stars as { rating?: unknown } | null)?.rating !== 'number') bad();
  for (const key of ['structure', 'rooms', 'transports', 'people', 'ledger'] as const) {
    if (!Array.isArray(st[key])) bad();
  }
}

/** Parse + migrate a save file string back into runtime state. */
export function deserialize(json: string): TowerState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SaveError('Save file is not valid JSON.');
  }
  const file = migrateToCurrent(raw);
  assertValidState(file.state);
  return file.state;
}

function storageAvailable(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function saveToLocalStorage(state: TowerState, savedAt: number): boolean {
  // Never overwrite a good save with a nullish state (e.g. a beforeunload
  // handler firing after something upstream went wrong).
  if (!state || !storageAvailable()) return false;
  try {
    localStorage.setItem(SAVE_KEY, serialize(state, savedAt));
    return true;
  } catch {
    return false; // quota exceeded or storage disabled — the game plays on
  }
}

export function loadFromLocalStorage(): TowerState | null {
  if (!storageAvailable()) return null;
  const json = localStorage.getItem(SAVE_KEY);
  if (json === null) return null;
  return deserialize(json); // throws SaveError on corruption — caller decides
}

export function hasSave(): boolean {
  return storageAvailable() && localStorage.getItem(SAVE_KEY) !== null;
}

export function clearSave(): void {
  if (storageAvailable()) localStorage.removeItem(SAVE_KEY);
}
