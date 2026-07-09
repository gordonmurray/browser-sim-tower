/**
 * The single game scene: wires renderer, input, backdrop, effects and the
 * fixed-timestep simulation driver. The sim advances in whole sim-minutes
 * from an accumulator — never tied to frame rate; rendering reads whatever
 * state exists each frame and smooths motion on its own.
 */
import Phaser from 'phaser';
import { GRID_WIDTH, MAX_FLOOR, MIN_FLOOR } from '../../core/constants';
import { tick } from '../../core/engine';
import type { Room } from '../../core/state';
import type { SimEvent } from '../../core/sim/events';
import type { GameApp, Tool } from '../app';
import { Backdrop } from '../environment/backdrop';
import type { WeatherService } from '../environment/weather';
import { InputController } from '../input/inputController';
import { EffectsLayer } from '../render/effects';
import { CELL_H, CELL_W, cellLeft, floorTop } from '../render/palette';
import { TowerRenderer } from '../render/towerRenderer';
import type { Hud } from '../ui/hud';

/** Real ms per sim-minute at each speed (0 = paused). ~2 min per sim-day at 1×. */
const SPEED_MS: Record<number, number> = { 0: Infinity, 1: 80, 2: 40, 3: 20 };
const MAX_TICKS_PER_FRAME = 30;
const AUTOSAVE_INTERVAL_MS = 30_000;

export class GameScene extends Phaser.Scene {
  private towerRenderer!: TowerRenderer;
  private inputCtl!: InputController;
  private backdrop!: Backdrop;
  private effects!: EffectsLayer;
  private accumulator = 0;
  private lastAutosave = 0;
  private lastSpeed: 1 | 2 | 3 = 1;

  constructor(
    private app: GameApp,
    private hud: Hud,
    private weather: WeatherService,
    private saveNow: () => void,
  ) {
    super({ key: 'game' });
  }

  create(): void {
    this.backdrop = new Backdrop(this, this.app);
    this.towerRenderer = new TowerRenderer(this, this.app);
    this.effects = new EffectsLayer(this);
    this.inputCtl = new InputController(this, this.app, this.towerRenderer, this.effects);

    const worldW = GRID_WIDTH * CELL_W;
    const worldH = (MAX_FLOOR - MIN_FLOOR + 1) * CELL_H;
    this.cameras.main.setBounds(-500, -700, worldW + 1000, worldH + 1400);
    this.cameras.main.setZoom(1);
    this.inputCtl.focusGround();

    this.weather.subscribe((w) => {
      this.backdrop.onWeather(w);
      this.hud.setWeather(w);
    });

    const kb = this.input.keyboard;
    kb?.on('keydown-SPACE', () => this.togglePause());
    kb?.on('keydown-ONE', () => this.setSpeed(1));
    kb?.on('keydown-TWO', () => this.setSpeed(2));
    kb?.on('keydown-THREE', () => this.setSpeed(3));
    kb?.on('keydown-ESC', () => {
      if (!this.hud.closeOverlays()) this.setTool({ kind: 'inspect' });
    });
    kb?.on('keydown-Q', () => this.setTool({ kind: 'inspect' }));
    kb?.on('keydown-X', () => this.setTool({ kind: 'demolish' }));
    kb?.on('keydown-F', () => this.setTool({ kind: 'floor' }));
    kb?.on('keydown-T', () => this.setTool({ kind: 'stairs' }));
    kb?.on('keydown-R', () => this.setTool({ kind: 'escalator' }));
    kb?.on('keydown-E', () => this.setTool({ kind: 'elevator' }));
    kb?.on('keydown-G', () => this.inputCtl.focusGround(true));
    kb?.on('keydown-HOME', () => this.inputCtl.focusGround(true));
    kb?.on('keydown-H', () => this.hud.toggleHelp());

    // Save when the tab hides or closes.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveNow();
    });
    window.addEventListener('beforeunload', () => this.saveNow());

    this.app.ui.onCommandApplied = () => this.towerRenderer.markDirty();
    this.app.ui.recenter = () => this.inputCtl.focusGround(true);

    // Dev/test-only hook (stripped from production builds).
    if (import.meta.env.DEV && window.__simTower) window.__simTower.scene = this;
  }

  private setTool(tool: Tool): void {
    this.app.tool = tool;
    this.hud.refresh();
  }

  private setSpeed(speed: 1 | 2 | 3): void {
    this.lastSpeed = speed;
    this.app.issue({ kind: 'SetSpeed', speed });
    this.hud.refresh();
  }

  private togglePause(): void {
    if (this.app.state.speed === 0) {
      this.app.issue({ kind: 'SetSpeed', speed: this.lastSpeed });
    } else {
      this.lastSpeed = this.app.state.speed as 1 | 2 | 3;
      this.app.issue({ kind: 'SetSpeed', speed: 0 });
    }
    this.hud.refresh();
  }

  override update(time: number, delta: number): void {
    const state = this.app.state;
    const msPerMinute = SPEED_MS[state.speed] ?? Infinity;

    if (Number.isFinite(msPerMinute)) {
      this.accumulator += delta;
      let ticks = 0;
      let dayRolled = false;
      while (this.accumulator >= msPerMinute && ticks < MAX_TICKS_PER_FRAME) {
        this.accumulator -= msPerMinute;
        ticks += 1;
        const events = tick(state);
        if (events.length > 0) {
          this.hud.onEvents(events);
          this.routeEffects(events);
          if (events.some((e) => e.kind === 'day')) dayRolled = true;
          this.towerRenderer.markDirty();
        }
      }
      // Drop backlog if we can't keep up (e.g. after a background tab stall).
      if (this.accumulator > msPerMinute * MAX_TICKS_PER_FRAME) {
        this.accumulator = 0;
      }
      if (dayRolled) this.app.saveDirty = true;
    }

    // Autosave on a throttle whenever something changed.
    if (this.app.saveDirty && time - this.lastAutosave > AUTOSAVE_INTERVAL_MS) {
      this.lastAutosave = time;
      this.app.saveDirty = false;
      this.saveNow();
    }

    this.towerRenderer.update(time, delta);
    this.backdrop.update(delta);
    this.hud.update(time);
  }

  // -------------------------------------------------------------- effects

  private roomCenter(roomId: number): { x: number; y: number } | null {
    const room = this.app.state.rooms.find((r) => r.id === roomId);
    if (!room) return null;
    return this.centerOf(room);
  }

  private centerOf(room: Room): { x: number; y: number } {
    return {
      x: cellLeft(room.x) + (room.w * CELL_W) / 2,
      y: floorTop(room.y + room.h - 1) + 4,
    };
  }

  /** Money/celebration effects anchored to the rooms that earned them. */
  private routeEffects(events: SimEvent[]): void {
    const state = this.app.state;
    const lobby = state.rooms.find((r) => r.type === 'lobby');
    const anchor = lobby
      ? this.centerOf(lobby)
      : { x: (GRID_WIDTH / 2) * CELL_W, y: floorTop(0) };

    for (const e of events) {
      switch (e.kind) {
        case 'quarter': {
          const str = `${e.net >= 0 ? '+' : '−'}$${Math.abs(e.net).toLocaleString()}`;
          this.effects.floatText(anchor.x, anchor.y - 10, str, e.net >= 0 ? '#5fd68b' : '#ff6b6b');
          break;
        }
        case 'condoSold': {
          const at = this.roomCenter(e.roomId) ?? anchor;
          this.effects.floatText(at.x, at.y, `+$${e.price.toLocaleString()}`, '#5fd68b');
          this.effects.burst(at.x, at.y + 8, 14);
          break;
        }
        case 'hotelNight':
          this.effects.floatText(anchor.x, anchor.y - 10, `+$${e.income.toLocaleString()} hotel`, '#5fd68b');
          break;
        case 'retailDay':
          if (e.income > 0) {
            this.effects.floatText(anchor.x, anchor.y - 24, `+$${e.income.toLocaleString()} retail`, '#67d4ff');
          }
          break;
        case 'moveIn': {
          const at = this.roomCenter(e.roomId);
          if (at) this.effects.burst(at.x, at.y + 8, 10);
          break;
        }
        case 'moveOut': {
          const at = this.roomCenter(e.roomId);
          if (at) this.effects.puff(at.x, at.y + 8, 10);
          break;
        }
        case 'starUp': {
          this.effects.burst(anchor.x, anchor.y - 40, 60);
          this.effects.burst(anchor.x - 80, anchor.y - 90, 30);
          this.effects.burst(anchor.x + 80, anchor.y - 90, 30);
          break;
        }
        case 'day':
          break;
      }
    }
  }
}
