/**
 * Draws TowerState onto the grid. Immediate-mode Phaser Graphics in layers:
 *   ground (static world furniture) → building (rooms with procedural
 *   interiors, transports, roofline, lighting) → dynamic (cars, people,
 *   selection pulse) → ghost.
 *
 * The building layer redraws on a slow cadence (or when a command lands);
 * cars and people redraw every frame with render-side smoothing so sub-minute
 * motion looks continuous even though the sim steps in whole minutes.
 * Interiors are deterministic per room id (hashU) so nothing flickers.
 */
import Phaser from 'phaser';
import { GIVE_UP_WAIT_MINUTES, GRID_WIDTH, MIN_FLOOR } from '../../core/constants';
import { hasStructure } from '../../core/grid/grid';
import { ROOM_CATALOG } from '../../core/rooms/catalog';
import type { Person, Room, Transport } from '../../core/state';
import { clockOf } from '../../core/sim/time';
import type { GameApp } from '../app';
import {
  brighten,
  CELL_H,
  CELL_W,
  cellLeft,
  COLORS,
  dimColor,
  floorTop,
  hashU,
  mixColor,
  satisfactionColor,
} from './palette';

export interface GhostRect {
  x: number;
  y: number; // floor of the LOWEST row
  w: number;
  h: number; // floors tall
  ok: boolean;
}

const GROUND_Y = () => floorTop(0) + CELL_H;

export class TowerRenderer {
  private buildingGfx: Phaser.GameObjects.Graphics;
  private dynamicGfx: Phaser.GameObjects.Graphics;
  private ghostGfx: Phaser.GameObjects.Graphics;
  private frame = 0;
  private buildingDirty = true;
  private smoothPeople = new Map<number, { x: number; y: number }>();
  private smoothCars = new Map<number, number>();
  ghost: GhostRect | null = null;

  constructor(
    private scene: Phaser.Scene,
    private app: GameApp,
  ) {
    this.buildingGfx = scene.add.graphics().setDepth(10);
    this.dynamicGfx = scene.add.graphics().setDepth(20);
    this.ghostGfx = scene.add.graphics().setDepth(30);
    this.drawGroundOnce();
  }

  markDirty(): void {
    this.buildingDirty = true;
  }

  update(timeMs: number, deltaMs: number): void {
    this.frame += 1;
    if (this.buildingDirty || this.frame % 20 === 0) {
      this.drawBuilding();
      this.buildingDirty = false;
    }
    this.drawDynamic(timeMs, deltaMs);
    this.drawGhost(timeMs);
  }

  // ---------------------------------------------------------------- ground

  /**
   * Static world furniture: earth strata, pavement, road, trees, lamps.
   * Drawn ONCE into tileable textures and shown as TileSprites — keeping
   * thousands of static primitives out of the per-frame Graphics path.
   */
  private drawGroundOnce(): void {
    const groundY = GROUND_Y();
    const worldW = GRID_WIDTH * CELL_W;
    const left = -60 * CELL_W;
    const width = worldW + 120 * CELL_W;
    const earthDepth = (0 - MIN_FLOOR) * CELL_H;
    const TILE_W = 512;

    // Earth tile: strata bands fading with depth, speckled with rocks.
    const eg = this.scene.add.graphics();
    const bands = 6;
    for (let i = 0; i < bands; i++) {
      eg.fillStyle(mixColor(COLORS.earthTop, COLORS.earthDeep, i / (bands - 1)), 1);
      eg.fillRect(0, (earthDepth * i) / bands, TILE_W, earthDepth / bands + 1);
    }
    for (let i = 0; i < 70; i++) {
      eg.fillStyle(mixColor(COLORS.earthDeep, 0x555044, hashU(i, 3) * 0.6), 1);
      eg.fillRect(hashU(i, 1) * (TILE_W - 6), 8 + hashU(i, 2) * (earthDepth - 16), 2 + hashU(i, 4) * 3, 2);
    }
    eg.generateTexture('earth-tile', TILE_W, earthDepth);
    eg.destroy();
    this.scene.add
      .tileSprite(left, groundY, width, earthDepth, 'earth-tile')
      .setOrigin(0, 0)
      .setDepth(5);

    // Street tile: grass verge, road with dashes, trees, lamps, bushes.
    const STREET_H = 44;
    const sg = this.scene.add.graphics();
    sg.fillStyle(COLORS.road, 1);
    sg.fillRect(0, STREET_H - 12, TILE_W, 9);
    sg.fillStyle(0xcfd4dc, 0.8);
    for (let x = 6; x < TILE_W; x += 46) {
      sg.fillRect(x, STREET_H - 8, 14, 1.5);
    }
    sg.fillStyle(COLORS.groundGrass, 1);
    sg.fillRect(0, STREET_H - 14, TILE_W, 3);
    sg.fillStyle(COLORS.pavement, 1);
    sg.fillRect(0, STREET_H - 3, TILE_W, 3);
    for (let i = 0; i < 13; i++) {
      const tx = 18 + hashU(i, 7) * (TILE_W - 36);
      const kind = hashU(i, 8);
      if (kind < 0.55) {
        sg.fillStyle(0x4a3524, 1);
        sg.fillRect(tx - 1.5, STREET_H - 26, 3, 13);
        const green = mixColor(0x3d6b35, 0x6d9b4a, hashU(i, 9));
        sg.fillStyle(green, 1);
        sg.fillCircle(tx, STREET_H - 30, 7 + hashU(i, 10) * 3);
        sg.fillCircle(tx - 5, STREET_H - 26, 5);
        sg.fillCircle(tx + 5, STREET_H - 26, 5);
      } else if (kind < 0.7) {
        sg.fillStyle(0x3a3f49, 1);
        sg.fillRect(tx - 1, STREET_H - 34, 2, 21);
        sg.fillStyle(0xffe9a8, 0.9);
        sg.fillCircle(tx, STREET_H - 35, 2.4);
      } else if (kind < 0.8) {
        sg.fillStyle(0x466339, 1);
        sg.fillCircle(tx, STREET_H - 17, 4);
        sg.fillCircle(tx + 4, STREET_H - 16, 3);
      }
    }
    sg.generateTexture('street-tile', TILE_W, STREET_H);
    sg.destroy();
    this.scene.add
      .tileSprite(left, groundY + 2, width, STREET_H, 'street-tile')
      .setOrigin(0, 1)
      .setDepth(6);
  }

  // -------------------------------------------------------------- building

  private drawBuilding(): void {
    const g = this.buildingGfx;
    const state = this.app.state;
    const clock = clockOf(state.minutes);
    const light = { night: clock.isNight, evening: clock.hour >= 17 || clock.hour < 6, hour: clock.hour };
    g.clear();

    // Empty structure: girder floors waiting to be filled.
    for (const floor of state.structure) {
      for (const run of floor.runs) {
        this.drawStructureRun(g, run.x0, run.x1, floor.y);
      }
    }

    // Roofline: parapet + props over cells with nothing above.
    for (const floor of state.structure) {
      if (floor.y < 0) continue;
      for (const run of floor.runs) {
        this.drawRoofline(g, run.x0, run.x1, floor.y);
      }
    }

    for (const room of state.rooms) {
      this.drawRoom(g, room, light);
    }
    for (const t of state.transports) {
      this.drawTransport(g, t);
    }

    // Satisfaction overlay veils.
    if (this.app.overlay === 'satisfaction') {
      for (const room of state.rooms) {
        if (!room.occupied) continue;
        const left = cellLeft(room.x);
        const top = floorTop(room.y + room.h - 1);
        g.fillStyle(satisfactionColor(room.satisfaction), 0.42);
        g.fillRect(left + 1, top + 2, room.w * CELL_W - 2, room.h * CELL_H - 4);
      }
    }
  }

  private drawStructureRun(g: Phaser.GameObjects.Graphics, x0: number, x1: number, y: number): void {
    const left = cellLeft(x0);
    const top = floorTop(y);
    const width = (x1 - x0 + 1) * CELL_W;
    const basement = y < 0;

    g.fillStyle(basement ? COLORS.structureDark : COLORS.structure, 1);
    g.fillRect(left, top, width, CELL_H);
    // Girder diagonals hint "empty floor, build here".
    g.lineStyle(1, COLORS.girder, 0.5);
    for (let x = x0; x <= x1; x += 2) {
      const gx = cellLeft(x);
      g.lineBetween(gx + 2, top + CELL_H - 4, gx + 2 * CELL_W - 2, top + 4);
    }
    // Concrete slab under the row + thin edge.
    g.fillStyle(COLORS.slab, 1);
    g.fillRect(left, top + CELL_H - 3, width, 3);
    g.lineStyle(1, COLORS.structureEdge, 0.9);
    g.strokeRect(left, top, width, CELL_H);
  }

  private drawRoofline(g: Phaser.GameObjects.Graphics, x0: number, x1: number, y: number): void {
    const state = this.app.state;
    const top = floorTop(y);
    let openStart: number | null = null;
    const flush = (endX: number) => {
      if (openStart === null) return;
      const left = cellLeft(openStart);
      const width = (endX - openStart) * CELL_W;
      g.fillStyle(COLORS.roof, 1);
      g.fillRect(left, top - 4, width, 4);
      // Occasional rooftop props.
      for (let x = openStart; x < endX; x++) {
        const h = hashU(x, y * 7 + 3);
        const px = cellLeft(x) + 4;
        if (h > 0.86) {
          g.fillStyle(0x4a5163, 1);
          g.fillRect(px, top - 11, 9, 7);
          g.fillStyle(0x373d4c, 1);
          g.fillRect(px + 1, top - 12, 7, 2);
        } else if (h > 0.8) {
          g.lineStyle(1.5, 0x596174, 1);
          g.lineBetween(px + 4, top - 4, px + 4, top - 16);
          g.fillStyle(0xd8574f, 1);
          g.fillCircle(px + 4, top - 17, 1.6);
        }
      }
      openStart = null;
    };
    for (let x = x0; x <= x1; x++) {
      if (!hasStructure(state, x, y + 1)) {
        if (openStart === null) openStart = x;
      } else {
        flush(x);
      }
    }
    flush(x1 + 1);
  }

  // ------------------------------------------------------------------ rooms

  private drawRoom(
    g: Phaser.GameObjects.Graphics,
    room: Room,
    light: { night: boolean; evening: boolean; hour: number },
  ): void {
    const { night, evening, hour } = light;
    const def = ROOM_CATALOG[room.type];
    const left = cellLeft(room.x);
    const top = floorTop(room.y + room.h - 1);
    const width = room.w * CELL_W;
    const height = room.h * CELL_H;
    const rated = ['office', 'residence', 'hotel'].includes(def.category);
    const vacant = rated && !room.occupied;
    const seed = room.id;

    // Interior box.
    const ix = left + 1;
    const iy = top + 2;
    const iw = width - 2;
    const ih = height - 5;

    // Walls: a soft pastel of the type color; vacant rooms grey out.
    let wall = mixColor(COLORS.room[room.type], 0xffffff, 0.55);
    wall = mixColor(wall, 0x9097a5, vacant ? 0.75 : 0.12);
    if (room.hotel?.state === 'dirty') wall = mixColor(wall, COLORS.dirtyHotel, 0.55);
    g.fillStyle(wall, 1);
    g.fillRect(ix, iy, iw, ih);
    // Floor strip.
    g.fillStyle(dimColor(wall, 0.62), 1);
    g.fillRect(ix, iy + ih - 3, iw, 3);

    if (!vacant) {
      this.drawInterior(g, room, ix, iy, iw, ih, seed, light);
    } else {
      // Vacant: bare room + a little FOR RENT board.
      g.fillStyle(0xffffff, 0.85);
      g.fillRect(ix + iw / 2 - 6, iy + ih / 2 - 4, 12, 7);
      g.fillStyle(0x8a4a44, 1);
      g.fillRect(ix + iw / 2 - 4, iy + ih / 2 - 2, 8, 1.4);
      g.fillRect(ix + iw / 2 - 4, iy + ih / 2 + 0.5, 5, 1.2);
    }

    // Type accent line along the top (readable color-coding at any zoom).
    g.fillStyle(COLORS.room[room.type], 1);
    g.fillRect(ix, iy, iw, 2);

    // Night: unlit rooms fall into shadow; lit ones glow.
    const retailOpen =
      def.openHour !== undefined && hour >= def.openHour && hour < (def.closeHour ?? 24);
    const lit =
      room.type === 'lobby' ||
      (room.occupied &&
        (def.category === 'retail'
          ? retailOpen
          : def.category === 'office'
            ? !night
            : evening || night));
    if (night && !lit) {
      g.fillStyle(COLORS.nightVeil, 0.55);
      g.fillRect(ix, iy, iw, ih);
    } else if (night && lit) {
      g.lineStyle(1, COLORS.windowLit, 0.55);
      g.strokeRect(ix - 0.5, iy - 0.5, iw + 1, ih + 1);
    }

    if (!room.reachable) {
      g.lineStyle(1.5, COLORS.unreachable, 0.95);
      g.strokeRect(ix, iy, iw, ih);
      g.lineBetween(ix, iy, ix + iw, iy + ih);
      // Warning tag.
      g.fillStyle(COLORS.unreachable, 1);
      g.fillTriangle(ix + 2, iy + 10, ix + 12, iy + 10, ix + 7, iy + 2);
      g.fillStyle(0xffffff, 1);
      g.fillRect(ix + 6.4, iy + 4, 1.4, 3.2);
      g.fillRect(ix + 6.4, iy + 8, 1.4, 1.2);
    }
  }

  private drawInterior(
    g: Phaser.GameObjects.Graphics,
    room: Room,
    ix: number,
    iy: number,
    iw: number,
    ih: number,
    seed: number,
    light: { night: boolean; evening: boolean; hour: number },
  ): void {
    const { night, evening } = light;
    const bottom = iy + ih - 3;
    switch (room.type) {
      case 'lobby': {
        g.fillStyle(0xe9dcb8, 1);
        g.fillRect(ix, iy + ih - 6, iw, 3);
        for (let cx = ix + 10; cx < ix + iw - 6; cx += 3 * CELL_W) {
          g.fillStyle(0xcbb277, 1);
          g.fillRect(cx, iy + 3, 3, ih - 6);
          g.fillStyle(0xe3d1a0, 1);
          g.fillRect(cx - 1, iy + 3, 5, 2);
        }
        // Reception desk + plants.
        g.fillStyle(0x8a6f42, 1);
        g.fillRect(ix + iw * 0.32, bottom - 7, 16, 7);
        g.fillStyle(0x3f6b3a, 1);
        g.fillCircle(ix + 6, bottom - 8, 3.4);
        g.fillCircle(ix + iw - 6, bottom - 8, 3.4);
        g.fillStyle(0x7a5a35, 1);
        g.fillRect(ix + 4.5, bottom - 5, 3, 5);
        g.fillRect(ix + iw - 7.5, bottom - 5, 3, 5);
        break;
      }
      case 'office': {
        const bays = Math.max(2, Math.floor(room.w / 2));
        const bayW = iw / bays;
        const working = !night && room.occupied;
        for (let b = 0; b < bays; b++) {
          const bx = ix + b * bayW + bayW / 2;
          g.fillStyle(0x5d5346, 1);
          g.fillRect(bx - 5, bottom - 6, 10, 2);
          g.fillRect(bx - 4, bottom - 4, 1.5, 4);
          g.fillRect(bx + 2.5, bottom - 4, 1.5, 4);
          g.fillStyle(working ? 0x9fe8ff : 0x27313f, 1);
          g.fillRect(bx - 2.5, bottom - 10, 5, 3.6);
          if (hashU(seed, b) > 0.55) {
            g.fillStyle(0x424a58, 1);
            g.fillRect(bx + 6, bottom - 5, 3, 5); // chair
          }
        }
        break;
      }
      case 'condo': {
        const hue = hashU(seed, 1);
        const sofaColor = mixColor(0xc4574e, 0x4e7dc4, hue);
        g.fillStyle(sofaColor, 1);
        g.fillRoundedRect(ix + iw * 0.14, bottom - 7, 13, 5, 2);
        g.fillRect(ix + iw * 0.14, bottom - 9, 3, 4);
        // TV + stand.
        g.fillStyle(0x161a22, 1);
        g.fillRect(ix + iw * 0.6, bottom - 11, 8, 5);
        g.fillStyle(0x4a4136, 1);
        g.fillRect(ix + iw * 0.6 + 1, bottom - 5, 6, 2);
        // Plant.
        g.fillStyle(0x3f6b3a, 1);
        g.fillCircle(ix + iw - 6, bottom - 7, 2.6);
        g.fillStyle(0x7a5a35, 1);
        g.fillRect(ix + iw - 7.2, bottom - 5, 2.4, 4);
        // Curtains.
        g.fillStyle(mixColor(0xd8b25f, 0x9fb7d8, hue), 0.9);
        g.fillRect(ix + 1, iy + 2, 2.4, ih - 6);
        g.fillRect(ix + iw - 3.4, iy + 2, 2.4, ih - 6);
        if (evening && room.occupied) {
          g.fillStyle(0xffe9a8, 0.9);
          g.fillCircle(ix + iw * 0.4, bottom - 10, 1.8);
        }
        break;
      }
      case 'hotelSingle':
      case 'hotelDouble':
      case 'hotelSuite': {
        const beds = room.type === 'hotelSingle' ? 1 : room.type === 'hotelDouble' ? 2 : 2;
        const duvet = mixColor(0x9a4a52, 0x4a6b9a, hashU(seed, 2));
        for (let b = 0; b < beds; b++) {
          const bx = ix + 4 + b * 15;
          g.fillStyle(0x6b5136, 1);
          g.fillRect(bx - 1, bottom - 8, 1.6, 8); // headboard
          g.fillStyle(duvet, 1);
          g.fillRect(bx, bottom - 6, 11, 5);
          g.fillStyle(0xf2f2ea, 1);
          g.fillRect(bx + 0.5, bottom - 6, 3.4, 2.6); // pillow
        }
        if (room.type === 'hotelSuite') {
          g.fillStyle(0x8a6f9a, 1);
          g.fillRoundedRect(ix + iw - 18, bottom - 6, 12, 5, 2);
        }
        // Nightstand + lamp.
        g.fillStyle(0x5d4a33, 1);
        g.fillRect(ix + iw - 5.4, bottom - 5, 3.4, 5);
        if (room.occupied) {
          g.fillStyle(0xffd98a, 0.95);
          g.fillCircle(ix + iw - 3.6, bottom - 7, 1.6);
        }
        if (room.hotel?.state === 'dirty') {
          g.fillStyle(0x6b5a42, 0.9);
          for (let i = 0; i < 6; i++) {
            g.fillRect(ix + 3 + hashU(seed, 10 + i) * (iw - 8), iy + 4 + hashU(seed, 20 + i) * (ih - 10), 2.4, 1.6);
          }
        }
        break;
      }
      case 'fastfood': {
        const brand = mixColor(0xe0483f, 0xe09b26, hashU(seed, 3));
        g.fillStyle(brand, 1);
        g.fillRect(ix, iy + 2, iw, 3.6); // sign band
        g.fillStyle(0xfff1cf, 1);
        for (let i = 0; i < 3; i++) {
          g.fillRect(ix + 4 + i * 8, iy + 7.5, 6, 4); // menu boards
        }
        g.fillStyle(0xd8cdb4, 1);
        g.fillRect(ix + 2, bottom - 7, iw - 4, 3.4); // counter
        g.fillStyle(brand, 1);
        g.fillRect(ix + 2, bottom - 3.8, iw - 4, 1.6);
        for (let sx = ix + 6; sx < ix + iw - 4; sx += 8) {
          g.fillStyle(0x555b66, 1);
          g.fillRect(sx, bottom - 3, 1.6, 3);
          g.fillStyle(0xe8e2d2, 1);
          g.fillCircle(sx + 0.8, bottom - 3.4, 1.8);
        }
        break;
      }
      case 'shop': {
        for (let row = 0; row < 2; row++) {
          const ry = iy + 8 + row * 9;
          g.fillStyle(0x9a8f7a, 1);
          g.fillRect(ix + 3, ry + 3.4, iw - 6, 1.4);
          for (let i = 0; i < Math.floor((iw - 8) / 5); i++) {
            g.fillStyle(mixColor(0xc46ad1, 0x5fb3d1, hashU(seed, row * 31 + i)), 1);
            g.fillRect(ix + 4 + i * 5, ry, 3.2, 3.2);
          }
        }
        g.fillStyle(0x5d5346, 1);
        g.fillRect(ix + iw - 9, bottom - 6, 6, 6); // till
        break;
      }
      case 'restaurant': {
        g.fillStyle(0x4a3a2c, 1);
        g.fillRect(ix, iy + ih - 6, iw, 3); // wood floor
        const tables = Math.max(2, Math.floor(room.w / 3));
        for (let tIdx = 0; tIdx < tables; tIdx++) {
          const tx = ix + ((tIdx + 0.5) * iw) / tables;
          g.fillStyle(0xf2ede0, 1);
          g.fillRect(tx - 4, bottom - 7, 8, 2.4);
          g.fillStyle(0x6b5136, 1);
          g.fillRect(tx - 0.8, bottom - 5, 1.6, 5);
          g.fillStyle(0xffc46a, 1);
          g.fillCircle(tx, bottom - 8, 1);
          // Pendant lamp.
          g.fillStyle(0x2a2f3a, 1);
          g.fillRect(tx - 0.5, iy + 3, 1, 4);
          g.fillStyle(0xffd98a, 0.95);
          g.fillCircle(tx, iy + 8, 1.8);
        }
        break;
      }
      case 'housekeeping': {
        for (let row = 0; row < 3; row++) {
          g.fillStyle(0x8a94a3, 1);
          g.fillRect(ix + 3, iy + 6 + row * 7, iw * 0.45, 1.2);
          g.fillStyle(0xf2f2ea, 1);
          for (let i = 0; i < 4; i++) {
            g.fillRect(ix + 4 + i * 6, iy + 3.4 + row * 7, 4.4, 2.4);
          }
        }
        g.fillStyle(0xd8dde5, 1);
        g.fillRect(ix + iw - 12, bottom - 9, 9, 9);
        g.fillStyle(0x39404e, 1);
        g.fillCircle(ix + iw - 7.5, bottom - 4.5, 2.8);
        break;
      }
      case 'security': {
        for (let r = 0; r < 2; r++) {
          for (let c = 0; c < 4; c++) {
            g.fillStyle(hashU(seed, r * 4 + c) > 0.2 ? 0x8fd8ff : 0x27313f, 1);
            g.fillRect(ix + 4 + c * 6, iy + 5 + r * 5.4, 4.4, 3.6);
          }
        }
        g.fillStyle(0x5d5346, 1);
        g.fillRect(ix + iw * 0.55, bottom - 6, 14, 2.4);
        g.fillStyle(0x424a58, 1);
        g.fillRect(ix + iw * 0.55 + 4, bottom - 4, 3, 4);
        break;
      }
      case 'medical': {
        g.fillStyle(0xffffff, 1);
        g.fillRect(ix + 3, iy + 4, 8, 8);
        g.fillStyle(0xd84a42, 1);
        g.fillRect(ix + 6, iy + 5.4, 2, 5.2);
        g.fillRect(ix + 4.4, iy + 7, 5.2, 2);
        g.fillStyle(0xe8ecef, 1);
        g.fillRect(ix + iw * 0.4, bottom - 6, 14, 3);
        g.fillStyle(0x8a94a3, 1);
        g.fillRect(ix + iw * 0.4 + 1, bottom - 3, 1.6, 3);
        g.fillRect(ix + iw * 0.4 + 11, bottom - 3, 1.6, 3);
        g.fillStyle(0xbfd8e8, 1);
        g.fillRect(ix + iw - 8, iy + 4, 5, ih - 10);
        break;
      }
      case 'recycling': {
        const binColors = [0x5f9b58, 0x4a7dc4, 0xd8b23c];
        for (let b = 0; b < 3; b++) {
          g.fillStyle(binColors[b]!, 1);
          g.fillRect(ix + 4 + b * 11, bottom - 9, 8, 9);
          g.fillStyle(dimColor(binColors[b]!, 0.6), 1);
          g.fillRect(ix + 4 + b * 11, bottom - 10.5, 8, 1.8);
        }
        g.lineStyle(2, 0x596174, 1);
        g.lineBetween(ix + iw * 0.55, iy + 5, ix + iw - 4, iy + 5);
        g.lineBetween(ix + iw - 4, iy + 5, ix + iw - 4, bottom - 2);
        break;
      }
      case 'parking': {
        g.fillStyle(0x2c2f36, 1);
        g.fillRect(ix, iy + 3, iw, ih - 3);
        g.fillStyle(0xcfd4dc, 0.7);
        const bays = Math.floor(room.w / 2);
        for (let b = 0; b <= bays; b++) {
          g.fillRect(ix + (b * iw) / bays - 0.5, bottom - 9, 1, 9);
        }
        for (let b = 0; b < bays; b++) {
          if (hashU(seed, 40 + b) > 0.45) {
            const carColor = mixColor(0xc4574e, 0x5f93c4, hashU(seed, 50 + b));
            const cx = ix + (b + 0.5) * (iw / bays);
            g.fillStyle(carColor, 1);
            g.fillRoundedRect(cx - 5.5, bottom - 6.4, 11, 4.4, 2);
            g.fillStyle(0x1c2028, 1);
            g.fillCircle(cx - 3, bottom - 1.6, 1.4);
            g.fillCircle(cx + 3, bottom - 1.6, 1.4);
          }
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------- transport

  private drawTransport(g: Phaser.GameObjects.Graphics, t: Transport): void {
    const left = cellLeft(t.x);
    const width = t.w * CELL_W;

    if (t.type === 'elevator') {
      const top = floorTop(t.yMax);
      const height = (t.yMax - t.yMin + 1) * CELL_H;
      g.fillStyle(COLORS.elevatorShaft, 1);
      g.fillRect(left, top, width, height);
      // Rails + cross braces.
      g.lineStyle(2, COLORS.elevatorRail, 1);
      g.lineBetween(left + 3, top, left + 3, top + height);
      g.lineBetween(left + width - 3, top, left + width - 3, top + height);
      g.lineStyle(1, COLORS.elevatorBrace, 0.9);
      for (let y = t.yMin; y <= t.yMax; y++) {
        const fy = floorTop(y);
        g.lineBetween(left + 3, fy + CELL_H, left + width - 3, fy);
        // Door frame where the floor has a landing.
        const landing =
          hasStructure(this.app.state, t.x - 1, y) ||
          hasStructure(this.app.state, t.x, y) ||
          hasStructure(this.app.state, t.x + t.w, y);
        if (landing) {
          g.lineStyle(1, COLORS.elevatorDoor, 0.8);
          g.strokeRect(left + 4.5, fy + 5, width - 9, CELL_H - 9);
          g.lineStyle(1, COLORS.elevatorBrace, 0.9);
        }
      }
      // Cap.
      g.fillStyle(COLORS.roof, 1);
      g.fillRect(left - 1, top - 4, width + 2, 4);
    } else {
      const top = floorTop(t.yMax);
      const isStairs = t.type === 'stairs';
      const color = isStairs ? COLORS.stairs : COLORS.escalator;
      g.fillStyle(0x1e222c, 0.85);
      g.fillRect(left, top, width, CELL_H * 2);
      if (isStairs) {
        // Zig-zag steps, bottom-left to top-right.
        const steps = 7;
        g.lineStyle(2, color, 1);
        for (let i = 0; i < steps; i++) {
          const sx = left + 2 + (i * (width - 4)) / steps;
          const sy = top + 2 * CELL_H - 5 - (i * (2 * CELL_H - 10)) / steps;
          g.lineBetween(sx, sy, sx + (width - 4) / steps, sy);
          if (i < steps - 1) {
            g.lineBetween(
              sx + (width - 4) / steps,
              sy,
              sx + (width - 4) / steps,
              sy - (2 * CELL_H - 10) / steps,
            );
          }
        }
      } else {
        // Escalator: diagonal band with teeth + balustrade.
        g.lineStyle(4, dimColor(color, 0.75), 1);
        g.lineBetween(left + 3, top + 2 * CELL_H - 6, left + width - 3, top + 6);
        g.lineStyle(1.4, brighten(color, 0.3), 1);
        g.lineBetween(left + 3, top + 2 * CELL_H - 10, left + width - 3, top + 2);
        const teeth = 8;
        g.lineStyle(1, 0x1e222c, 0.8);
        for (let i = 0; i <= teeth; i++) {
          const tx = left + 3 + (i * (width - 6)) / teeth;
          const ty = top + 2 * CELL_H - 6 - (i * (2 * CELL_H - 12)) / teeth;
          g.lineBetween(tx, ty - 2.5, tx, ty + 2.5);
        }
      }
      g.lineStyle(1, dimColor(color, 0.5), 0.9);
      g.strokeRect(left, top, width, CELL_H * 2);
    }
  }

  // ---------------------------------------------------------------- dynamic

  private drawDynamic(timeMs: number, deltaMs: number): void {
    const g = this.dynamicGfx;
    const state = this.app.state;
    g.clear();

    const ease = Math.min(1, deltaMs * 0.011);

    // Elevator cars.
    const liveCars = new Set<number>();
    for (const t of state.transports) {
      if (t.type !== 'elevator' || !t.cars) continue;
      const left = cellLeft(t.x);
      const width = t.w * CELL_W;
      for (const car of t.cars) {
        liveCars.add(car.id);
        const targetY = floorTop(car.y) + 3;
        let cy = this.smoothCars.get(car.id);
        if (cy === undefined || Math.abs(cy - targetY) > CELL_H * 8) cy = targetY;
        cy += (targetY - cy) * ease;
        this.smoothCars.set(car.id, cy);

        const carH = CELL_H - 6;
        const doorsOpen = car.stopTimer > 0 && Math.abs(cy - targetY) < 3;
        // Cabin.
        g.fillStyle(doorsOpen || car.passengerIds.length > 0 ? COLORS.elevatorCarLit : 0xcfa63a, 1);
        g.fillRect(left + 5, cy, width - 10, carH);
        g.fillStyle(0x27313f, 1);
        g.fillRect(left + 5, cy, width - 10, 3);
        if (doorsOpen) {
          g.fillStyle(0x0f131b, 0.85);
          g.fillRect(left + width / 2 - 2.4, cy + 3, 4.8, carH - 6);
        }
        // Passenger heads.
        const shown = Math.min(5, car.passengerIds.length);
        for (let i = 0; i < shown; i++) {
          g.fillStyle(0x39404e, 1);
          g.fillCircle(left + 8 + i * 6, cy + carH - 7, 2.1);
        }
        // Load bar + direction chevron.
        if (car.passengerIds.length > 0) {
          const load = car.passengerIds.length / 15;
          g.fillStyle(load > 0.85 ? 0xff7060 : 0x67d4ff, 1);
          g.fillRect(left + 5, cy + carH - 2, (width - 10) * load, 2);
        }
        if (car.dir !== 0) {
          const chY = car.dir > 0 ? cy - 4 : cy + carH + 4;
          g.fillStyle(0xffe9b0, 0.95);
          g.fillTriangle(
            left + width / 2 - 3.4, chY + (car.dir > 0 ? 2.6 : -2.6),
            left + width / 2 + 3.4, chY + (car.dir > 0 ? 2.6 : -2.6),
            left + width / 2, chY - (car.dir > 0 ? 1.8 : -1.8),
          );
        }
      }
    }
    if (this.frame % 300 === 0) {
      for (const id of this.smoothCars.keys()) if (!liveCars.has(id)) this.smoothCars.delete(id);
    }

    // People.
    const livePeople = new Set<number>();
    for (const person of state.people) {
      const phase = person.phase.kind;
      if (phase === 'riding') continue;

      let tx: number;
      let ty: number;
      if (person.phase.kind === 'traversing') {
        const transportId = person.phase.transportId;
        const t = state.transports.find((tr) => tr.id === transportId);
        const pos = this.traversePosition(person, t);
        tx = pos.x;
        ty = pos.y;
      } else {
        tx = person.x * CELL_W + CELL_W / 2;
        ty = floorTop(person.floor) + CELL_H - 3;
        // Waiting crowds fan out beside the doors instead of stacking.
        if (phase === 'waitingElevator') {
          tx += ((person.id % 7) - 3) * 3.4;
        }
      }

      livePeople.add(person.id);
      let sp = this.smoothPeople.get(person.id);
      if (!sp || Math.abs(sp.x - tx) > 260 || Math.abs(sp.y - ty) > CELL_H * 2.5) {
        sp = { x: tx, y: ty };
      }
      sp.x += (tx - sp.x) * ease;
      sp.y += (ty - sp.y) * ease;
      this.smoothPeople.set(person.id, sp);

      this.drawPerson(g, person, sp.x, sp.y, timeMs, phase);
    }
    if (this.frame % 300 === 0) {
      for (const id of this.smoothPeople.keys()) if (!livePeople.has(id)) this.smoothPeople.delete(id);
    }

    // Selection pulse.
    const sel = this.app.selection;
    if (sel) {
      const pulse = 0.55 + 0.45 * Math.sin(timeMs / 220);
      g.lineStyle(2, COLORS.selection, pulse);
      if (sel.kind === 'room') {
        const room = state.rooms.find((r) => r.id === sel.id);
        if (room) {
          g.strokeRect(
            cellLeft(room.x) - 1,
            floorTop(room.y + room.h - 1),
            room.w * CELL_W + 2,
            room.h * CELL_H - 1,
          );
        }
      } else {
        const t = state.transports.find((tr) => tr.id === sel.id);
        if (t) {
          const span = t.type === 'elevator' ? t.yMax - t.yMin + 1 : 2;
          g.strokeRect(cellLeft(t.x) - 1, floorTop(t.yMax) - 1, t.w * CELL_W + 2, span * CELL_H + 2);
        }
      }
    }
  }

  /** Where a person on stairs/escalator is drawn, by leg progress. */
  private traversePosition(person: Person, t: Transport | undefined): { x: number; y: number } {
    if (!t || person.phase.kind !== 'traversing') {
      return { x: person.x * CELL_W + CELL_W / 2, y: floorTop(person.floor) + CELL_H - 3 };
    }
    const from = person.floor;
    const to = person.phase.toFloor;
    const perFloor = t.type === 'stairs' ? 2 : 0.75;
    const total = Math.max(0.001, Math.abs(to - from) * perFloor);
    const progress = Math.max(0, Math.min(1, 1 - person.phase.minutesLeft / total));
    const goingUp = to > from;
    const left = cellLeft(t.x) + 3;
    const right = cellLeft(t.x) + t.w * CELL_W - 3;
    const yFrom = floorTop(from) + CELL_H - 3;
    const yTo = floorTop(to) + CELL_H - 3;
    // Stairs draw bottom-left → top-right; walk that diagonal.
    const x = goingUp ? left + (right - left) * progress : right - (right - left) * progress;
    return { x, y: yFrom + (yTo - yFrom) * progress };
  }

  private drawPerson(
    g: Phaser.GameObjects.Graphics,
    person: Person,
    x: number,
    y: number,
    timeMs: number,
    phase: string,
  ): void {
    let color = COLORS.person[person.kind];
    let bob = 0;
    if (phase === 'walking' || phase === 'traversing') {
      bob = Math.sin(timeMs / 90 + person.id * 1.7) * 1.1;
    }
    if (phase === 'waitingElevator' && person.phase.kind === 'waitingElevator') {
      const irritation = Math.min(1, person.phase.waitedMin / GIVE_UP_WAIT_MINUTES);
      color = mixColor(color, COLORS.personImpatient, irritation * 0.85);
    }
    const alpha = phase === 'dwelling' ? 0.45 : 1;
    // Body + head.
    g.fillStyle(color, alpha);
    g.fillRect(x - 2, y - 7 + bob * 0.4, 4, 6.5);
    g.fillCircle(x, y - 9 + bob * 0.6, 2.1);
    // Feet shuffle.
    if (bob !== 0) {
      g.fillRect(x - 2, y - 1, 1.6, Math.max(0.6, 1 + bob * 0.8));
      g.fillRect(x + 0.4, y - 1, 1.6, Math.max(0.6, 1 - bob * 0.8));
    }
  }

  // ------------------------------------------------------------------ ghost

  private drawGhost(timeMs: number): void {
    const g = this.ghostGfx;
    g.clear();
    if (!this.ghost) return;
    const { x, y, w, h, ok } = this.ghost;
    const left = cellLeft(x);
    const top = floorTop(y + h - 1);
    const color = ok ? COLORS.ghostOk : COLORS.ghostBad;
    const pulse = 0.24 + 0.08 * Math.sin(timeMs / 260);
    g.fillStyle(color, pulse);
    g.fillRect(left, top, w * CELL_W, h * CELL_H);
    g.lineStyle(2, color, 0.95);
    g.strokeRect(left, top, w * CELL_W, h * CELL_H);
    // Cell ticks along the base for a sense of size while dragging.
    g.lineStyle(1, color, 0.5);
    for (let cx = 1; cx < w; cx++) {
      g.lineBetween(left + cx * CELL_W, top + h * CELL_H - 4, left + cx * CELL_W, top + h * CELL_H);
    }
  }
}
