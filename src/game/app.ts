/**
 * Shared game-side context: the single TowerState instance, the active tool,
 * selection, and the command funnel. Everything UI/render/input shares lives
 * here; the simulation itself knows nothing about it.
 */
import { applyCommand, type Command, type CommandResult } from '../core/engine';
import type { RoomTypeId, TowerState } from '../core/state';
import type { SimEvent } from '../core/sim/events';

export type Tool =
  | { kind: 'inspect' }
  | { kind: 'demolish' }
  | { kind: 'room'; type: RoomTypeId }
  | { kind: 'floor' }
  | { kind: 'stairs' }
  | { kind: 'escalator' }
  | { kind: 'elevator' };

export type Selection =
  | { kind: 'room'; id: number }
  | { kind: 'transport'; id: number }
  | null;

export interface GhostInfo {
  ok: boolean;
  text: string;
  screenX: number;
  screenY: number;
}

export interface UiHooks {
  onEvents(events: SimEvent[]): void;
  onCommandApplied(): void;
  showGhost(info: GhostInfo | null): void;
  refresh(): void;
  /** Re-frame the camera on the tower (set by the scene, which owns it). */
  recenter(): void;
}

export class GameApp {
  state: TowerState;
  tool: Tool = { kind: 'inspect' };
  selection: Selection = null;
  overlay: 'none' | 'satisfaction' = 'none';
  /** Set after any accepted command; the autosaver picks it up. */
  saveDirty = false;
  ui: UiHooks = {
    onEvents: () => undefined,
    onCommandApplied: () => undefined,
    showGhost: () => undefined,
    refresh: () => undefined,
    recenter: () => undefined,
  };

  constructor(state: TowerState) {
    this.state = state;
  }

  issue(cmd: Command): CommandResult {
    const result = applyCommand(this.state, cmd);
    if (result.ok) {
      this.saveDirty = true;
      this.ui.onCommandApplied();
    }
    return result;
  }

  replaceState(state: TowerState): void {
    this.state = state;
    this.selection = null;
    this.saveDirty = true;
    this.ui.refresh();
  }
}
