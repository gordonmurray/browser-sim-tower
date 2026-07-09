/**
 * Translates pointer/keyboard input into camera moves and core Commands.
 * Left click/drag places with the active tool (room drags place a row of
 * rooms); right or middle drag pans (a plain right-click cancels back to
 * inspect); wheel zooms. Nothing here mutates state directly — everything
 * goes through app.issue().
 */
import Phaser from 'phaser';
import { ELEVATOR_SHAFT_WIDTH, GRID_WIDTH, MAX_FLOOR, MIN_FLOOR } from '../../core/constants';
import { STAIRLIKE_WIDTH, type Command } from '../../core/engine';
import { roomAt, transportAt } from '../../core/grid/grid';
import { ROOM_CATALOG } from '../../core/rooms/catalog';
import {
  FAILURE_MESSAGES,
  planFloorCells,
  validateDemolish,
  validateElevatorPlacement,
  validateFloorPlacement,
  validateRoomPlacement,
  validateStairlike,
} from '../../core/rules/rules';
import type { RoomTypeId } from '../../core/state';
import type { GameApp } from '../app';
import type { EffectsLayer } from '../render/effects';
import { CELL_H, CELL_W, cellLeft, floorTop, worldToCell } from '../render/palette';
import type { GhostRect, TowerRenderer } from '../render/towerRenderer';
import { sound } from '../ui/sound';

type DragState =
  | { kind: 'pan'; lastX: number; lastY: number; moved: number; viaRightClick: boolean }
  | { kind: 'floor'; y: number; startX: number; endX: number }
  | { kind: 'elevator'; x: number; startY: number; endY: number }
  | { kind: 'rooms'; type: RoomTypeId; y: number; startX: number; endX: number };

export class InputController {
  private drag: DragState | null = null;

  constructor(
    private scene: Phaser.Scene,
    private app: GameApp,
    private renderer: TowerRenderer,
    private effects: EffectsLayer,
  ) {
    scene.input.mouse?.disableContextMenu();

    scene.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    scene.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    scene.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p));
    scene.input.on('pointerupoutside', (p: Phaser.Input.Pointer) => this.onUp(p));
    scene.input.on(
      'wheel',
      (p: Phaser.Input.Pointer, _objs: unknown, _dx: number, dy: number) => this.onWheel(p, dy),
    );
  }

  private cellAt(p: Phaser.Input.Pointer): { x: number; y: number } {
    const world = this.scene.cameras.main.getWorldPoint(p.x, p.y);
    return worldToCell(world.x, world.y);
  }

  private onDown(p: Phaser.Input.Pointer): void {
    if (p.rightButtonDown() || p.middleButtonDown()) {
      this.drag = { kind: 'pan', lastX: p.x, lastY: p.y, moved: 0, viaRightClick: p.rightButtonDown() };
      return;
    }
    const cell = this.cellAt(p);
    const tool = this.app.tool;
    switch (tool.kind) {
      case 'inspect': {
        const room = roomAt(this.app.state, cell.x, cell.y);
        const transport = room ? undefined : transportAt(this.app.state, cell.x, cell.y);
        this.app.selection = room
          ? { kind: 'room', id: room.id }
          : transport
            ? { kind: 'transport', id: transport.id }
            : null;
        if (!room && !transport) {
          this.drag = { kind: 'pan', lastX: p.x, lastY: p.y, moved: 0, viaRightClick: false };
        }
        this.app.ui.refresh();
        this.renderer.markDirty();
        break;
      }
      case 'demolish': {
        this.issueAndReport(p, { kind: 'Demolish', x: cell.x, y: cell.y });
        break;
      }
      case 'room': {
        this.drag = { kind: 'rooms', type: tool.type, y: cell.y, startX: cell.x, endX: cell.x };
        break;
      }
      case 'stairs': {
        this.issueAndReport(p, { kind: 'PlaceStairs', x: cell.x, y: cell.y });
        break;
      }
      case 'escalator': {
        this.issueAndReport(p, { kind: 'PlaceEscalator', x: cell.x, y: cell.y });
        break;
      }
      case 'floor': {
        this.drag = { kind: 'floor', y: cell.y, startX: cell.x, endX: cell.x };
        break;
      }
      case 'elevator': {
        this.drag = { kind: 'elevator', x: cell.x, startY: cell.y, endY: cell.y };
        break;
      }
    }
    this.updateGhost(p);
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (this.drag?.kind === 'pan') {
      const cam = this.scene.cameras.main;
      cam.scrollX -= (p.x - this.drag.lastX) / cam.zoom;
      cam.scrollY -= (p.y - this.drag.lastY) / cam.zoom;
      this.drag.moved += Math.abs(p.x - this.drag.lastX) + Math.abs(p.y - this.drag.lastY);
      this.drag.lastX = p.x;
      this.drag.lastY = p.y;
      return;
    }
    const cell = this.cellAt(p);
    if (this.drag?.kind === 'floor') this.drag.endX = cell.x;
    if (this.drag?.kind === 'elevator') this.drag.endY = cell.y;
    if (this.drag?.kind === 'rooms') this.drag.endX = cell.x;
    this.updateGhost(p);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const drag = this.drag;
    this.drag = null;
    if (!drag) return;
    if (drag.kind === 'pan') {
      // A plain right-click (no real movement) cancels back to inspect.
      if (drag.viaRightClick && drag.moved < 6 && this.app.tool.kind !== 'inspect') {
        this.app.tool = { kind: 'inspect' };
        this.app.ui.refresh();
        sound.play('click');
      }
      return;
    }
    if (drag.kind === 'floor') {
      const x0 = Math.min(drag.startX, drag.endX);
      const x1 = Math.max(drag.startX, drag.endX);
      this.issueAndReport(p, { kind: 'PlaceFloor', y: drag.y, x0, x1 });
    }
    if (drag.kind === 'elevator') {
      const yMin = Math.min(drag.startY, drag.endY);
      let yMax = Math.max(drag.startY, drag.endY);
      if (yMin === yMax) yMax += 1; // a click gives a minimal useful shaft
      this.issueAndReport(p, { kind: 'PlaceElevator', x: drag.x, yMin, yMax });
    }
    if (drag.kind === 'rooms') {
      this.placeRoomRow(p, drag);
    }
    this.updateGhost(p);
  }

  /** Place every room slot covered by the drag; report one combined result. */
  private placeRoomRow(p: Phaser.Input.Pointer, drag: { type: RoomTypeId; y: number; startX: number; endX: number }): void {
    const def = ROOM_CATALOG[drag.type];
    const dir = drag.endX >= drag.startX ? 1 : -1;
    const span = Math.abs(drag.endX - drag.startX);
    const count = Math.max(1, Math.floor(span / def.w) + 1);
    let placed = 0;
    let firstFailure: string | null = null;
    for (let i = 0; i < count; i++) {
      const cmd: Command = { kind: 'PlaceRoom', type: drag.type, x: drag.startX + i * def.w * dir, y: drag.y };
      const r = this.app.issue(cmd);
      if (r.ok) {
        placed += 1;
        this.effects.burst(cellLeft(cmd.x) + (def.w * CELL_W) / 2, floorTop(drag.y) + CELL_H / 2, 6);
      } else if (!firstFailure) {
        firstFailure = FAILURE_MESSAGES[r.reason];
      }
    }
    if (placed > 0) {
      this.renderer.markDirty();
      sound.play('build');
    } else if (firstFailure) {
      sound.play('error');
      this.app.ui.showGhost({ ok: false, text: firstFailure, screenX: p.x, screenY: p.y });
    }
  }

  private onWheel(p: Phaser.Input.Pointer, dy: number): void {
    const cam = this.scene.cameras.main;
    const before = cam.getWorldPoint(p.x, p.y);
    const factor = dy > 0 ? 0.88 : 1.14;
    // Floor the zoom-out so the whole 70-floor world still roughly fills the
    // screen: any further and the tower shrinks into an easily-lost speck
    // (a real hazard on touchpads that pinch-zoom by accident).
    cam.setZoom(Phaser.Math.Clamp(cam.zoom * factor, 0.35, 2.6));
    const after = cam.getWorldPoint(p.x, p.y);
    cam.scrollX += before.x - after.x;
    cam.scrollY += before.y - after.y;
  }

  private issueAndReport(p: Phaser.Input.Pointer, cmd: Command): void {
    const result = this.app.issue(cmd);
    if (result.ok) {
      this.renderer.markDirty();
      if (cmd.kind === 'Demolish') {
        const world = this.scene.cameras.main.getWorldPoint(p.x, p.y);
        this.effects.puff(world.x, world.y, 12);
        sound.play('demolish');
      } else {
        sound.play('build');
      }
    } else {
      sound.play('error');
      this.app.ui.showGhost({
        ok: false,
        text: FAILURE_MESSAGES[result.reason],
        screenX: p.x,
        screenY: p.y,
      });
    }
  }

  /** Recompute the placement ghost + tooltip for the current hover cell. */
  updateGhost(p: Phaser.Input.Pointer): void {
    const state = this.app.state;
    const tool = this.app.tool;
    const cell = this.cellAt(p);
    let ghost: GhostRect | null = null;
    let text = '';
    let ok = false;

    const inGrid =
      cell.x >= 0 && cell.x < GRID_WIDTH && cell.y >= MIN_FLOOR && cell.y <= MAX_FLOOR;

    if (inGrid) {
      switch (tool.kind) {
        case 'room': {
          const def = ROOM_CATALOG[tool.type];
          const d = this.drag?.kind === 'rooms' ? this.drag : null;
          if (d) {
            const dir = d.endX >= d.startX ? 1 : -1;
            const span = Math.abs(d.endX - d.startX);
            const count = Math.max(1, Math.floor(span / def.w) + 1);
            let okCount = 0;
            let cost = 0;
            let firstReason: string | null = null;
            for (let i = 0; i < count; i++) {
              const x = d.startX + i * def.w * dir;
              const v = validateRoomPlacement(state, d.type, x, d.y);
              if (v.ok) {
                okCount += 1;
                cost += v.cost;
              } else if (!firstReason) {
                firstReason = FAILURE_MESSAGES[v.reason];
              }
            }
            ok = okCount > 0;
            text = ok
              ? `${okCount}× ${def.name} — $${cost.toLocaleString()}`
              : (firstReason ?? 'Cannot build here.');
            const left = dir > 0 ? d.startX : d.startX - (count - 1) * def.w;
            ghost = { x: left, y: d.y, w: count * def.w, h: def.h, ok };
          } else {
            const v = validateRoomPlacement(state, tool.type, cell.x, cell.y);
            ok = v.ok;
            text = v.ok
              ? `${def.name} — $${v.cost.toLocaleString()} (drag for more)`
              : FAILURE_MESSAGES[v.reason];
            ghost = { x: cell.x, y: cell.y, w: def.w, h: def.h, ok };
          }
          break;
        }
        case 'floor': {
          const d = this.drag?.kind === 'floor' ? this.drag : null;
          const y = d ? d.y : cell.y;
          const x0 = d ? Math.min(d.startX, d.endX) : cell.x;
          const x1 = d ? Math.max(d.startX, d.endX) : cell.x;
          const v = validateFloorPlacement(state, y, x0, x1);
          ok = v.ok;
          if (v.ok) {
            const plan = planFloorCells(state, y, x0, x1);
            text = `Floor · ${plan.newCells} cell${plan.newCells === 1 ? '' : 's'} — $${v.cost.toLocaleString()}`;
          } else {
            text = FAILURE_MESSAGES[v.reason];
          }
          ghost = { x: x0, y, w: x1 - x0 + 1, h: 1, ok };
          break;
        }
        case 'stairs':
        case 'escalator': {
          const w = STAIRLIKE_WIDTH[tool.kind];
          const v = validateStairlike(state, tool.kind, cell.x, cell.y, w);
          ok = v.ok;
          text = v.ok
            ? `${tool.kind === 'stairs' ? 'Stairs' : 'Escalator'} — $${v.cost.toLocaleString()}`
            : FAILURE_MESSAGES[v.reason];
          ghost = { x: cell.x, y: cell.y, w, h: 2, ok };
          break;
        }
        case 'elevator': {
          const d = this.drag?.kind === 'elevator' ? this.drag : null;
          const x = d ? d.x : cell.x;
          const yMin = d ? Math.min(d.startY, d.endY) : cell.y;
          let yMax = d ? Math.max(d.startY, d.endY) : cell.y;
          if (yMin === yMax) yMax += 1;
          const v = validateElevatorPlacement(state, x, yMin, yMax);
          ok = v.ok;
          text = v.ok
            ? `Elevator · ${yMax - yMin + 1} floors — $${v.cost.toLocaleString()}${d ? '' : ' (drag for taller)'}`
            : FAILURE_MESSAGES[v.reason];
          ghost = { x, y: yMin, w: ELEVATOR_SHAFT_WIDTH, h: yMax - yMin + 1, ok };
          break;
        }
        case 'demolish': {
          const v = validateDemolish(state, cell.x, cell.y);
          ok = v.ok;
          text = v.ok ? 'Demolish' : FAILURE_MESSAGES[v.reason];
          ghost = { x: cell.x, y: cell.y, w: 1, h: 1, ok };
          break;
        }
        case 'inspect':
          break;
      }
    }

    this.renderer.ghost = ghost;
    this.app.ui.showGhost(ghost && text ? { ok, text, screenX: p.x, screenY: p.y } : null);
  }

  /**
   * Re-frame the camera on the lobby / ground floor at a readable zoom. This
   * is the "I'm lost" rescue: a stray touchpad pinch can zoom far out and pan
   * the tower off-screen, so recenter always resets zoom to 1 as well as
   * position. Animated when triggered by the player, instant on first load.
   */
  focusGround(smooth = false): void {
    const cam = this.scene.cameras.main;
    const lobby = this.app.state.rooms.find((r) => r.type === 'lobby');
    const cx = lobby ? cellLeft(lobby.x) + (lobby.w * CELL_W) / 2 : (GRID_WIDTH / 2) * CELL_W;
    const cy = floorTop(0) - 4 * CELL_H;
    if (smooth) {
      cam.pan(cx, cy, 420, 'Cubic.easeOut', true);
      cam.zoomTo(1, 420, 'Cubic.easeOut', true);
    } else {
      cam.setZoom(1);
      cam.centerOn(cx, cy);
    }
  }
}
