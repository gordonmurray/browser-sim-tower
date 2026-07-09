/**
 * Weather service: coarse geolocation + Open-Meteo (no API key, CORS-friendly)
 * mapped to a small backdrop descriptor. View-layer only — never touches the
 * simulation or saved state. The game must stay fully playable offline: every
 * failure path falls back to a sensible default.
 */
import { ENV_CONFIG } from './config';

export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow';

export interface WeatherDescriptor {
  condition: WeatherCondition;
  isNight: boolean;
  source: 'live' | 'cached' | 'default';
}

type Listener = (w: WeatherDescriptor) => void;

interface CacheEntry {
  ts: number;
  condition: WeatherCondition;
  isNight: boolean;
  lat: number;
  lon: number;
}

function mapWmoCode(code: number): WeatherCondition {
  if (code === 0 || code === 1) return 'clear';
  if (code === 2 || code === 3 || code === 45 || code === 48) return 'cloudy';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82) || code >= 95) return 'rain';
  return 'cloudy';
}

function localNightNow(): boolean {
  const h = new Date().getHours();
  return h < 6 || h >= 20;
}

export function defaultWeather(): WeatherDescriptor {
  return { condition: 'clear', isNight: localNightNow(), source: 'default' };
}

export class WeatherService {
  private listeners: Listener[] = [];
  private current: WeatherDescriptor = defaultWeather();
  private timer: number | null = null;

  get descriptor(): WeatherDescriptor {
    return this.current;
  }

  subscribe(fn: Listener): void {
    this.listeners.push(fn);
    fn(this.current);
  }

  start(): void {
    // Dev/testing override: ?weather=rain-night forces a condition (and
    // optional night) without touching the network. View-layer only.
    const forced = this.parseForced();
    if (forced) {
      this.emit(forced);
      return;
    }
    void this.refresh();
    this.timer = window.setInterval(() => void this.refresh(), ENV_CONFIG.refreshMinutes * 60_000);
  }

  private parseForced(): WeatherDescriptor | null {
    try {
      const raw = new URLSearchParams(window.location.search).get('weather');
      if (!raw) return null;
      const parts = raw.split('-');
      const cond = parts[0] as WeatherCondition;
      if (!['clear', 'cloudy', 'rain', 'snow'].includes(cond)) return null;
      return { condition: cond, isNight: parts.includes('night'), source: 'default' };
    } catch {
      return null;
    }
  }

  stop(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
  }

  private emit(w: WeatherDescriptor): void {
    this.current = w;
    for (const fn of this.listeners) fn(w);
  }

  private readCache(): CacheEntry | null {
    try {
      const raw = localStorage.getItem(ENV_CONFIG.cacheKey);
      if (!raw) return null;
      return JSON.parse(raw) as CacheEntry;
    } catch {
      return null;
    }
  }

  private writeCache(entry: CacheEntry): void {
    try {
      localStorage.setItem(ENV_CONFIG.cacheKey, JSON.stringify(entry));
    } catch {
      /* storage full/disabled — live without the cache */
    }
  }

  private async refresh(): Promise<void> {
    const cache = this.readCache();
    const fresh = cache && Date.now() - cache.ts < ENV_CONFIG.refreshMinutes * 60_000;
    if (fresh) {
      this.emit({ condition: cache.condition, isNight: cache.isNight, source: 'cached' });
      return;
    }
    // Show last-known (stale) weather while we refetch.
    if (cache) this.emit({ condition: cache.condition, isNight: cache.isNight, source: 'cached' });

    const coords = await this.getCoords(cache);
    if (!coords) {
      if (!cache) this.emit(defaultWeather());
      return;
    }
    try {
      const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat.toFixed(2)}` +
        `&longitude=${coords.lon.toFixed(2)}&current=weather_code,is_day&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { current?: { weather_code?: number; is_day?: number } };
      const code = data.current?.weather_code ?? 0;
      const isNight = (data.current?.is_day ?? 1) === 0;
      const condition = mapWmoCode(code);
      this.writeCache({ ts: Date.now(), condition, isNight, lat: coords.lat, lon: coords.lon });
      this.emit({ condition, isNight, source: 'live' });
    } catch {
      // Network failure: keep whatever we last showed; default if nothing.
      if (!cache) this.emit(defaultWeather());
    }
  }

  /** Coarse coordinates: geolocation → cached coords → manual city → null. */
  private async getCoords(cache: CacheEntry | null): Promise<{ lat: number; lon: number } | null> {
    const geo = await new Promise<{ lat: number; lon: number } | null>((resolve) => {
      if (!('geolocation' in navigator)) {
        resolve(null);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
        () => resolve(null),
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 30 * 60_000 },
      );
    });
    if (geo) return geo;
    if (cache) return { lat: cache.lat, lon: cache.lon };
    return this.geocodeManualCity();
  }

  /** Optional manual city fallback (set via localStorage). */
  private async geocodeManualCity(): Promise<{ lat: number; lon: number } | null> {
    let city: string | null = null;
    try {
      city = localStorage.getItem(ENV_CONFIG.manualCityKey);
    } catch {
      return null;
    }
    if (!city) return null;
    try {
      const res = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { results?: Array<{ latitude: number; longitude: number }> };
      const hit = data.results?.[0];
      return hit ? { lat: hit.latitude, lon: hit.longitude } : null;
    } catch {
      return null;
    }
  }
}
