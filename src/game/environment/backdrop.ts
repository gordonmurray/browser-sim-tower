/**
 * Sky backdrop behind the tower: layered gradient sky, a sun/moon that arcs
 * with the clock, twinkling stars, drifting clouds, parallax city skyline and
 * rain/snow particles. Subscribes to the weather descriptor and eases between
 * states continuously. Knows nothing about how weather is fetched.
 *
 * Sky day/night follows real local time by default, or the sim clock when the
 * player flips the setting (see environment/config.ts). Weather condition is
 * always the real one. View-layer only — never touches the simulation.
 */
import Phaser from 'phaser';
import { GRID_WIDTH } from '../../core/constants';
import { clockOf } from '../../core/sim/time';
import type { GameApp } from '../app';
import { CELL_H, CELL_W, floorTop, hashU, mixColor } from '../render/palette';
import { skyMode } from './config';
import type { WeatherDescriptor } from './weather';

interface SkyPalette {
  top: number;
  horizon: number;
}

const CLEAR_DAY: SkyPalette = { top: 0x4a97d8, horizon: 0xaed9f2 };
const CLEAR_NIGHT: SkyPalette = { top: 0x060919, horizon: 0x1c2344 };
const GREY_DAY: SkyPalette = { top: 0x6b7888, horizon: 0xb2bcc6 };
const GREY_NIGHT: SkyPalette = { top: 0x0a0d16, horizon: 0x232834 };

export class Backdrop {
  private skyGfx: Phaser.GameObjects.Graphics;
  private celestialGfx: Phaser.GameObjects.Graphics;
  private stars: Array<{ rect: Phaser.GameObjects.Rectangle; base: number; speed: number }> = [];
  private clouds: Array<{ parts: Phaser.GameObjects.Ellipse[]; speed: number }> = [];
  private rain: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private snow: Phaser.GameObjects.Particles.ParticleEmitter | null = null;
  private skylineWindows: Phaser.GameObjects.TileSprite[] = [];
  private weather: WeatherDescriptor = { condition: 'clear', isNight: false, source: 'default' };
  private daylight = 0.5; // eased 0 (night) .. 1 (day)
  private lastSkyKey = '';
  private lastCelestialKey = '';
  private particleKey = '';
  private elapsed = 0;

  constructor(
    private scene: Phaser.Scene,
    private app: GameApp,
  ) {
    this.skyGfx = scene.add.graphics().setScrollFactor(0).setDepth(-30);
    this.celestialGfx = scene.add.graphics().setScrollFactor(0).setDepth(-28);
    this.makeStars();
    this.makeSkyline();
    this.makeClouds();
    this.makeParticles();
    scene.scale.on('resize', () => {
      this.lastSkyKey = '';
      this.lastCelestialKey = '';
    });
  }

  private makeStars(): void {
    const { width, height } = this.scene.scale;
    for (let i = 0; i < 90; i++) {
      const rect = this.scene.add
        .rectangle(hashU(i, 1) * width * 1.2, hashU(i, 2) * height * 0.72, 1.6, 1.6, 0xffffff)
        .setScrollFactor(0)
        .setDepth(-29)
        .setAlpha(0);
      this.stars.push({ rect, base: 0.25 + hashU(i, 3) * 0.65, speed: 0.4 + hashU(i, 4) * 1.6 });
    }
  }

  /**
   * Two parallax bands of city silhouettes, glued to the world ground line.
   * Each band is drawn ONCE into a tileable texture and shown as a
   * TileSprite — re-tessellating thousands of Graphics rects per frame is
   * what software renderers choke on.
   */
  private makeSkyline(): void {
    const groundY = floorTop(0) + CELL_H;
    const centerX = (GRID_WIDTH / 2) * CELL_W;
    const TILE_W = 1024;
    const TILE_H = 360;
    const SPAN = 7200;
    const bands = [
      { key: 'skyfar', depth: -26, factor: 0.12, color: 0x232a3d, winAlphaScale: 0.7, hMin: 60, hMax: 200, seed: 11 },
      { key: 'skynear', depth: -25, factor: 0.32, color: 0x1a2030, winAlphaScale: 1, hMin: 90, hMax: 300, seed: 23 },
    ];
    for (const band of bands) {
      const silhouette = this.scene.add.graphics();
      const windows = this.scene.add.graphics();
      let x = 0;
      let i = 0;
      while (x < TILE_W - 40) {
        const w = 46 + hashU(i, band.seed) * 90;
        const h = band.hMin + hashU(i, band.seed + 1) * (band.hMax - band.hMin);
        silhouette.fillStyle(band.color, 1);
        silhouette.fillRect(x, TILE_H - h, Math.min(w, TILE_W - x), h);
        if (hashU(i, band.seed + 2) > 0.72) {
          silhouette.fillRect(x + w * 0.3, TILE_H - h - 10, w * 0.4, 10);
        }
        windows.fillStyle(0xffd98a, 0.85 * band.winAlphaScale);
        for (let wy = TILE_H - h + 8; wy < TILE_H - 12; wy += 14) {
          for (let wx = x + 5; wx < Math.min(x + w, TILE_W) - 6; wx += 11) {
            if (hashU(Math.round(wx), Math.round(wy) + band.seed) > 0.82) {
              windows.fillRect(wx, wy, 3.4, 4.4);
            }
          }
        }
        x += w + 6 + hashU(i, band.seed + 3) * 26;
        i += 1;
      }
      silhouette.generateTexture(band.key, TILE_W, TILE_H);
      windows.generateTexture(`${band.key}-win`, TILE_W, TILE_H);
      silhouette.destroy();
      windows.destroy();

      this.scene.add
        .tileSprite(centerX - SPAN / 2, groundY, SPAN, TILE_H, band.key)
        .setOrigin(0, 1)
        .setDepth(band.depth)
        .setScrollFactor(band.factor, 1);
      const win = this.scene.add
        .tileSprite(centerX - SPAN / 2, groundY, SPAN, TILE_H, `${band.key}-win`)
        .setOrigin(0, 1)
        .setDepth(band.depth)
        .setScrollFactor(band.factor, 1);
      this.skylineWindows.push(win);
    }
  }

  private makeClouds(): void {
    const { width } = this.scene.scale;
    for (let i = 0; i < 7; i++) {
      const y = 30 + hashU(i, 31) * 200;
      const cx = hashU(i, 32) * width;
      const scale = 0.7 + hashU(i, 33) * 0.9;
      const parts: Phaser.GameObjects.Ellipse[] = [];
      const puffs = [
        { dx: 0, dy: 0, w: 120, h: 34 },
        { dx: -38, dy: 8, w: 70, h: 24 },
        { dx: 42, dy: 6, w: 80, h: 26 },
        { dx: 8, dy: -12, w: 74, h: 26 },
      ];
      for (const p of puffs) {
        parts.push(
          this.scene.add
            .ellipse(cx + p.dx * scale, y + p.dy * scale, p.w * scale, p.h * scale, 0xffffff, 1)
            .setScrollFactor(0)
            .setDepth(-27)
            .setAlpha(0),
        );
      }
      this.clouds.push({ parts, speed: 0.004 + hashU(i, 34) * 0.008 });
    }
  }

  private makeParticles(): void {
    const { width, height } = this.scene.scale;
    const g = this.scene.add.graphics();
    g.fillStyle(0xbfd4e8, 1).fillRect(0, 0, 2, 9).generateTexture('raindrop', 2, 9);
    g.clear().fillStyle(0xffffff, 1).fillRect(0, 0, 3, 3).generateTexture('snowflake', 3, 3);
    g.destroy();

    this.rain = this.scene.add
      .particles(0, 0, 'raindrop', {
        x: { min: -60, max: width * 1.25 },
        y: -24,
        speedY: { min: 560, max: 760 },
        speedX: { min: -70, max: -40 },
        lifespan: 2600,
        quantity: 4,
        frequency: 16,
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(-22);
    this.snow = this.scene.add
      .particles(0, 0, 'snowflake', {
        x: { min: -60, max: width * 1.25 },
        y: -20,
        speedY: { min: 34, max: 80 },
        speedX: { min: -26, max: 26 },
        lifespan: Math.max(7000, (height / 55) * 1000),
        quantity: 2,
        frequency: 55,
        emitting: false,
      })
      .setScrollFactor(0)
      .setDepth(-22);
  }

  private daylightInitialized = false;

  onWeather(w: WeatherDescriptor): void {
    this.weather = w;
    // First real descriptor: start at the correct time of day instead of
    // easing in from a nowhere dusk.
    if (!this.daylightInitialized) {
      this.daylightInitialized = true;
      this.daylight = this.targetDaylight();
    }
  }

  /** Continuous daylight 0..1 (with dawn/dusk ramps in simClock mode). */
  private targetDaylight(): number {
    if (skyMode() === 'simClock') {
      const c = clockOf(this.app.state.minutes);
      const h = c.hour + c.minute / 60;
      if (h < 5.5 || h >= 21) return 0;
      if (h < 7.5) return (h - 5.5) / 2;
      if (h < 19) return 1;
      return 1 - (h - 19) / 2;
    }
    return this.weather.isNight ? 0 : 1;
  }

  update(deltaMs: number): void {
    this.elapsed += deltaMs;
    const target = this.targetDaylight();
    const ease = Math.min(1, deltaMs * (skyMode() === 'simClock' ? 0.004 : 0.0025));
    this.daylight += (target - this.daylight) * ease;
    if (Math.abs(target - this.daylight) < 0.004) this.daylight = target;
    const t = this.daylight;

    const grey = this.weather.condition === 'clear' ? 0 : this.weather.condition === 'cloudy' ? 0.55 : 0.8;
    const day = { top: mixColor(CLEAR_DAY.top, GREY_DAY.top, grey), horizon: mixColor(CLEAR_DAY.horizon, GREY_DAY.horizon, grey) };
    const night = { top: mixColor(CLEAR_NIGHT.top, GREY_NIGHT.top, grey), horizon: mixColor(CLEAR_NIGHT.horizon, GREY_NIGHT.horizon, grey) };
    const top = mixColor(night.top, day.top, t);
    const horizon = mixColor(night.horizon, day.horizon, t);
    // Warm band during transitions (dawn/dusk).
    const glow = 4 * t * (1 - t) * (1 - grey * 0.8);

    const skyKey = `${top}:${horizon}:${glow.toFixed(2)}`;
    if (skyKey !== this.lastSkyKey) {
      this.lastSkyKey = skyKey;
      this.drawSky(top, horizon, glow);
    }

    this.drawCelestial(t, grey);

    // Stars twinkle (clear nights only).
    const starVis = Math.max(0, 1 - t * 2) * (1 - grey);
    for (const s of this.stars) {
      s.rect.setAlpha(starVis * s.base * (0.7 + 0.3 * Math.sin(this.elapsed * 0.001 * s.speed + s.base * 20)));
    }

    // Skyline windows glow at night.
    for (const w of this.skylineWindows) {
      w.setAlpha(Math.max(0.06, 1 - t * 1.15));
    }

    // Clouds drift + fade by condition.
    const { width } = this.scene.scale;
    const cloudsOn = this.weather.condition !== 'clear';
    const cloudAlpha = !cloudsOn ? 0 : (0.35 + grey * 0.5) * (0.25 + 0.75 * Math.max(0.25, t));
    const cloudColor = mixColor(0x39404e, 0xffffff, Math.max(0.25, t) * (1 - grey * 0.45));
    for (const cloud of this.clouds) {
      let minX = Infinity;
      let maxX = -Infinity;
      for (const part of cloud.parts) {
        part.x += deltaMs * cloud.speed;
        minX = Math.min(minX, part.x - part.width / 2);
        maxX = Math.max(maxX, part.x + part.width / 2);
        part.setAlpha(Phaser.Math.Linear(part.alpha, cloudAlpha, Math.min(1, deltaMs * 0.002)));
        part.fillColor = cloudColor;
      }
      if (minX > width + 40) {
        const shift = maxX - minX + 80;
        for (const part of cloud.parts) part.x -= width + shift;
      }
    }

    // Rain/snow emitters follow the condition.
    const pKey = this.weather.condition;
    if (pKey !== this.particleKey) {
      this.particleKey = pKey;
      this.rain?.stop();
      this.snow?.stop();
      if (pKey === 'rain') this.rain?.start();
      if (pKey === 'snow') this.snow?.start();
    }
  }

  private drawSky(top: number, horizon: number, glow: number): void {
    const { width, height } = this.scene.scale;
    const g = this.skyGfx;
    g.clear();
    const mid = mixColor(top, horizon, 0.55);
    g.fillGradientStyle(top, top, mid, mid, 1);
    g.fillRect(0, 0, width, height * 0.55);
    g.fillGradientStyle(mid, mid, horizon, horizon, 1);
    g.fillRect(0, height * 0.55, width, height * 0.45);
    if (glow > 0.03) {
      const warm = 0xff9a4a;
      g.fillGradientStyle(warm, warm, warm, warm, 0, 0, glow * 0.5, glow * 0.5);
      g.fillRect(0, height * 0.42, width, height * 0.4);
    }
  }

  private drawCelestial(t: number, grey: number): void {
    const { width, height } = this.scene.scale;
    let sunX = width * 0.76;
    let sunY = height * 0.2;
    let moonX = width * 0.72;
    let moonY = height * 0.18;
    if (skyMode() === 'simClock') {
      const c = clockOf(this.app.state.minutes);
      const h = c.hour + c.minute / 60;
      const dayP = Phaser.Math.Clamp((h - 5.5) / 15, 0, 1);
      sunX = width * (0.08 + dayP * 0.84);
      sunY = height * (0.62 - Math.sin(dayP * Math.PI) * 0.5);
      const nightP = h >= 19 ? (h - 19) / 12 : (h + 5) / 12;
      moonX = width * (0.08 + Phaser.Math.Clamp(nightP, 0, 1) * 0.84);
      moonY = height * (0.55 - Math.sin(Phaser.Math.Clamp(nightP, 0, 1) * Math.PI) * 0.42);
    }
    const sunA = Math.max(0, t * 1.15 - 0.15) * (1 - grey * 0.85);
    const moonA = Math.max(0, 1 - t * 1.6) * (1 - grey * 0.7);
    const key = `${Math.round(sunX)}:${Math.round(sunY)}:${sunA.toFixed(2)}:${Math.round(moonX)}:${moonY.toFixed(0)}:${moonA.toFixed(2)}`;
    if (key === this.lastCelestialKey) return;
    this.lastCelestialKey = key;

    const g = this.celestialGfx;
    g.clear();
    if (sunA > 0.02) {
      g.fillStyle(0xffdf7e, sunA * 0.16);
      g.fillCircle(sunX, sunY, 52);
      g.fillStyle(0xffe9a0, sunA * 0.3);
      g.fillCircle(sunX, sunY, 34);
      g.fillStyle(0xfff3c4, sunA);
      g.fillCircle(sunX, sunY, 20);
    }
    if (moonA > 0.02) {
      g.fillStyle(0xf4f6ff, moonA * 0.12);
      g.fillCircle(moonX, moonY, 34);
      g.fillStyle(0xecf0ff, moonA);
      g.fillCircle(moonX, moonY, 15);
      // Crescent bite + craters.
      g.fillStyle(mixColor(CLEAR_NIGHT.top, 0x10142a, 0.4), moonA);
      g.fillCircle(moonX + 6.5, moonY - 2.5, 12.5);
      g.fillStyle(0xc9cfe4, moonA * 0.8);
      g.fillCircle(moonX - 5.5, moonY + 4, 2.1);
      g.fillCircle(moonX - 1.5, moonY - 4.5, 1.5);
    }
  }
}
