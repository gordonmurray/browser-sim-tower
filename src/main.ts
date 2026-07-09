/**
 * Boot: load (and migrate) the save or start a fresh tower, build the app
 * context + HUD + weather service, then start Phaser.
 */
import Phaser from 'phaser';
import './style.css';
import { tick } from './core/engine';
import { BALANCE } from './core/rooms/catalog';
import { createInitialState, type TowerState } from './core/state';
import { SaveError } from './save/migrations';
import {
  clearSave,
  deserialize,
  hasSave,
  loadFromLocalStorage,
  saveToLocalStorage,
  serialize,
} from './save/storage';
import { GameApp } from './game/app';
import { WeatherService } from './game/environment/weather';
import { GameScene } from './game/scenes/GameScene';
import { Hud } from './game/ui/hud';

function freshState(): TowerState {
  // Seeding happens outside the sim; inside, only the seeded RNG is used.
  const seed = (Date.now() ^ (Math.random() * 0x7fffffff)) | 0;
  return createInitialState(seed, BALANCE.startingMoney);
}

function loadOrCreate(): { state: TowerState; isNew: boolean } {
  try {
    const loaded = loadFromLocalStorage();
    if (loaded) return { state: loaded, isNew: false };
  } catch (err) {
    console.error('Save could not be loaded; starting fresh.', err);
    alert('Your save could not be loaded (it may be corrupted). Starting a new tower.');
    clearSave();
  }
  return { state: freshState(), isNew: true };
}

const { state, isNew } = loadOrCreate();
const app = new GameApp(state);
const weather = new WeatherService();

const saveNow = (): void => {
  saveToLocalStorage(app.state, Date.now());
};

const hud = new Hud(app, {
  saveNow: () => {
    saveNow();
    hud.toast('Game saved.', 'info');
  },
  newTower: () => {
    app.replaceState(freshState());
    saveNow();
    hud.toast('A brand new tower. Place a lobby on the ground line to begin!', 'star');
  },
  exportSave: () => {
    const blob = new Blob([serialize(app.state, Date.now())], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sim-tower-save-day${Math.floor(app.state.minutes / 1440) + 1}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  importSave: (json: string) => {
    try {
      const imported = deserialize(json);
      app.replaceState(imported);
      saveNow();
      hud.toast('Save imported.', 'good');
    } catch (err) {
      hud.toast(err instanceof SaveError ? err.message : 'That file is not a valid save.', 'bad');
    }
  },
});

app.ui.onEvents = (events) => hud.onEvents(events);
app.ui.showGhost = (info) => hud.showGhost(info);
app.ui.refresh = () => hud.refresh();

const scene = new GameScene(app, hud, weather, saveNow);

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game-root',
  backgroundColor: '#101318',
  scale: {
    mode: Phaser.Scale.RESIZE,
    width: window.innerWidth,
    height: window.innerHeight,
  },
  scene: [scene],
});

weather.start();

// Debug/testing handle (view-layer only; nothing in core knows about it).
declare global {
  interface Window {
    __simTower?: {
      app: GameApp;
      weather: WeatherService;
      step: (n: number) => void;
      /** Set by GameScene.create for tests that need camera math. */
      scene?: unknown;
    };
  }
}
// Dev/test builds only — the production bundle ships without this hook.
if (import.meta.env.DEV) {
  window.__simTower = {
    app,
    weather,
    // Deterministic fast-forward for tests/tools: advances the sim directly,
    // bypassing the frame loop (HUD reads state next frame; toasts are skipped).
    step: (n: number) => {
      for (let i = 0; i < n; i++) tick(app.state);
      app.saveDirty = true;
    },
  };
}

if (isNew || !hasSave()) {
  hud.toggleHelp();
  hud.toast('Welcome! Select Lobby and click the ground line to start your tower.', 'star');
}
