/**
 * Environment backdrop configuration.
 *
 * skyFollows:
 *  - 'realWorld' (default): the sky matches your actual local time and weather.
 *  - 'simClock': day/night tracks the sim clock instead (weather stays real).
 */
export const ENV_CONFIG = {
  skyFollows: 'realWorld' as 'realWorld' | 'simClock',
  /** How often to re-fetch weather (minutes). Never per-tick. */
  refreshMinutes: 20,
  /** localStorage keys (separate from the save — never part of game state). */
  cacheKey: 'browser-sim-tower.weather-cache',
  manualCityKey: 'browser-sim-tower.weather-city',
  /** Player preference override for skyFollows ('realWorld' | 'simClock'). */
  skyModeKey: 'browser-sim-tower.sky-mode',
};

/** Effective sky mode: player preference (settings menu) over the default. */
export function skyMode(): 'realWorld' | 'simClock' {
  try {
    const v = localStorage.getItem(ENV_CONFIG.skyModeKey);
    if (v === 'realWorld' || v === 'simClock') return v;
  } catch {
    /* storage unavailable — use the default */
  }
  return ENV_CONFIG.skyFollows;
}

export function setSkyMode(mode: 'realWorld' | 'simClock'): void {
  try {
    localStorage.setItem(ENV_CONFIG.skyModeKey, mode);
  } catch {
    /* storage unavailable — the toggle just won't persist */
  }
}
