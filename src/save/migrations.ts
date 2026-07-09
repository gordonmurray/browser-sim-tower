/**
 * Migration chain. Each entry migrate_vN_to_vNplus1 upgrades a version-N save
 * to version N+1. The runner walks the chain to CURRENT_SAVE_VERSION.
 * Migrations are pure: they return a new object and never mutate their input.
 *
 * Example for the future:
 *   function migrate_v1_to_v2(save: SaveFileV1): SaveFileV2 {
 *     return { ...structuredClone(save), saveVersion: 2, state: { ... } };
 *   }
 *   MIGRATIONS[1] = migrate_v1_to_v2;
 */
import { CURRENT_SAVE_VERSION, type CurrentSaveFile, type UnknownSaveFile } from './schema';

type Migration = (save: UnknownSaveFile) => UnknownSaveFile;

export const MIGRATIONS: Record<number, Migration> = {
  // none yet — version 1 is current
};

export class SaveError extends Error {}

export function migrateToCurrent(raw: unknown): CurrentSaveFile {
  if (typeof raw !== 'object' || raw === null || typeof (raw as UnknownSaveFile).saveVersion !== 'number') {
    throw new SaveError('Not a valid save file.');
  }
  let save = raw as UnknownSaveFile;
  if (save.saveVersion > CURRENT_SAVE_VERSION) {
    throw new SaveError(`Save version ${save.saveVersion} is newer than this game (v${CURRENT_SAVE_VERSION}).`);
  }
  while (save.saveVersion < CURRENT_SAVE_VERSION) {
    const migration = MIGRATIONS[save.saveVersion];
    if (!migration) {
      throw new SaveError(`No migration from save version ${save.saveVersion}.`);
    }
    const from = save.saveVersion;
    save = migration(save);
    if (save.saveVersion <= from) {
      throw new SaveError(`Migration from v${from} did not advance the version.`);
    }
  }
  return save as unknown as CurrentSaveFile;
}
