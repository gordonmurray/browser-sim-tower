/**
 * DOM HUD layered over the Phaser canvas: status clusters (money, population,
 * stars, clock), a bottom build dock with icon tiles, slide-in info panel,
 * goals/checklist widget, toasts, finances and help. Reads state, issues
 * commands via app, and never touches the simulation directly.
 */
import { MAX_CARS_PER_SHAFT } from '../../core/constants';
import { ROOM_CATALOG, STAR_THRESHOLDS } from '../../core/rooms/catalog';
import type { Room, RoomTypeId } from '../../core/state';
import type { SimEvent } from '../../core/sim/events';
import { clockOf, WEEKDAY_NAMES } from '../../core/sim/time';
import type { GameApp, GhostInfo, Tool } from '../app';
import { setSkyMode, skyMode } from '../environment/config';
import type { WeatherDescriptor } from '../environment/weather';
import { FAILURE_MESSAGES } from '../../core/rules/rules';
import { sound } from './sound';

export interface HudCallbacks {
  saveNow(): void;
  newTower(): void;
  exportSave(): void;
  importSave(json: string): void;
}

interface ToolTile {
  el: HTMLButtonElement;
  tool: Tool;
  starRequired: number;
}

interface TileSpec {
  tool: Tool;
  icon: string;
  name: string;
  price?: number;
  star: number;
  tip: string;
  hotkey?: string;
}

const GOALS_KEY = 'browser-sim-tower.goals-dismissed';

const ROOM_ICONS: Record<RoomTypeId, string> = {
  lobby: '🏛️',
  office: '💼',
  condo: '🏠',
  fastfood: '🍔',
  shop: '🛍️',
  restaurant: '🍽️',
  hotelSingle: '🛏️',
  hotelDouble: '🛏️',
  hotelSuite: '🛎️',
  housekeeping: '🧹',
  security: '🛡️',
  medical: '🏥',
  recycling: '♻️',
  parking: '🅿️',
};

const ROOM_SHORT: Partial<Record<RoomTypeId, string>> = {
  hotelSingle: 'Single',
  hotelDouble: 'Double',
  hotelSuite: 'Suite',
  housekeeping: 'Housekpg',
  restaurant: 'Restaur.',
  recycling: 'Recycle',
  medical: 'Clinic',
};

const ROOM_ORDER: RoomTypeId[] = [
  'lobby', 'office', 'condo', 'fastfood', 'shop', 'restaurant',
  'hotelSingle', 'hotelDouble', 'hotelSuite',
  'housekeeping', 'security', 'medical', 'recycling', 'parking',
];

function fmtMoney(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? '−' : ''}$${Math.abs(r).toLocaleString()}`;
}

function fmtPrice(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return `$${k % 1 === 0 ? k : k.toFixed(1)}k`;
  }
  return `$${n}`;
}

export class Hud {
  private root: HTMLElement;
  private moneyEl!: HTMLElement;
  private popEl!: HTMLElement;
  private starEl!: HTMLElement;
  private starProgressEl!: HTMLElement;
  private clockLabelEl!: HTMLElement;
  private clockEl!: HTMLElement;
  private weatherEl!: HTMLElement;
  private speedButtons: HTMLButtonElement[] = [];
  private moodBtn!: HTMLButtonElement;
  private soundBtn!: HTMLButtonElement;
  private menuEl!: HTMLElement;
  private toolTiles: ToolTile[] = [];
  private tooltipEl!: HTMLElement;
  private infoPanel!: HTMLElement;
  private goalsEl!: HTMLElement;
  private toastBox!: HTMLElement;
  private ghostTip!: HTMLElement;
  private financesPanel!: HTMLElement;
  private helpDim!: HTMLElement;
  private lastStatsUpdate = 0;
  private infoSignature = '';
  private goalsSignature = '';
  private displayedMoney: number | null = null;
  private lastMoney: number | null = null;
  private goalsDismissed = false;

  constructor(
    private app: GameApp,
    private callbacks: HudCallbacks,
  ) {
    try {
      this.goalsDismissed = localStorage.getItem(GOALS_KEY) === '1';
    } catch {
      this.goalsDismissed = false;
    }
    this.root = document.createElement('div');
    this.root.id = 'hud';
    document.body.appendChild(this.root);
    this.buildTopBar();
    this.buildDock();
    this.buildGoals();
    this.buildInfoPanel();
    this.buildToasts();
    this.buildGhostTip();
    this.buildFinances();
    this.buildHelp();
    this.refreshToolbar();
    document.addEventListener('pointerdown', (e) => {
      if (!this.menuEl.classList.contains('hidden') && !this.menuEl.parentElement!.contains(e.target as Node)) {
        this.menuEl.classList.add('hidden');
      }
    });
  }

  // ------------------------------------------------------------------ layout

  private buildTopBar(): void {
    const bar = el('div', 'topbar');

    const stats = el('div', 'cluster panel');
    stats.appendChild(this.stat('Funds', (v) => (this.moneyEl = v), 'money'));
    const popStat = this.stat('Population', (v) => (this.popEl = v));
    this.starProgressEl = el('div', '');
    const progress = el('div', 'progress');
    progress.appendChild(this.starProgressEl);
    popStat.appendChild(progress);
    stats.appendChild(popStat);
    stats.appendChild(this.stat('Rating', (v) => (this.starEl = v), 'stars'));
    const clockStat = this.stat('Day', (v) => (this.clockEl = v));
    clockStat.classList.add('clockchip');
    this.clockLabelEl = clockStat.querySelector('.label')!;
    stats.appendChild(clockStat);
    const weatherStat = this.stat('Sky', (v) => (this.weatherEl = v));
    weatherStat.classList.add('weatherchip');
    stats.appendChild(weatherStat);
    bar.appendChild(stats);

    bar.appendChild(el('span', 'spacer'));

    const controls = el('div', 'cluster panel');

    const recenter = button('🎯', () => {
      this.app.ui.recenter();
      sound.play('click');
    }, 'Recenter on your tower (press G)');
    recenter.classList.add('iconbtn');
    controls.appendChild(recenter);

    const seg = el('div', 'speedseg');
    const speedLabels = ['⏸', '1×', '2×', '3×'];
    for (const speed of [0, 1, 2, 3] as const) {
      const b = button(speedLabels[speed]!, () => {
        this.app.issue({ kind: 'SetSpeed', speed });
        this.refreshSpeed();
        sound.play('click');
      }, speed === 0 ? 'Pause (Space)' : `Speed ${speed}× (key ${speed})`);
      this.speedButtons.push(b);
      seg.appendChild(b);
    }
    controls.appendChild(seg);

    this.moodBtn = button('😊', () => {
      this.app.overlay = this.app.overlay === 'none' ? 'satisfaction' : 'none';
      this.moodBtn.classList.toggle('active', this.app.overlay !== 'none');
      sound.play('click');
    }, 'Mood overlay: color every room by satisfaction');
    this.moodBtn.classList.add('iconbtn');
    controls.appendChild(this.moodBtn);

    this.soundBtn = button(sound.muted ? '🔇' : '🔊', () => {
      const muted = sound.toggleMute();
      this.soundBtn.textContent = muted ? '🔇' : '🔊';
      if (!muted) sound.play('click');
    }, 'Toggle sound');
    this.soundBtn.classList.add('iconbtn');
    controls.appendChild(this.soundBtn);

    const menuWrap = el('div', 'menuwrap');
    const menuBtn = button('☰', () => {
      this.menuEl.classList.toggle('hidden');
    }, 'Menu');
    menuBtn.classList.add('iconbtn');
    menuWrap.appendChild(menuBtn);
    this.menuEl = el('div', 'menu panel hidden');
    this.buildMenu();
    menuWrap.appendChild(this.menuEl);
    controls.appendChild(menuWrap);

    bar.appendChild(controls);
    this.root.appendChild(bar);
    this.refreshSpeed();
  }

  private stat(label: string, capture: (v: HTMLElement) => void, valueClass = ''): HTMLElement {
    const wrap = el('div', 'stat');
    wrap.appendChild(el('div', 'label', label));
    const value = el('div', `value ${valueClass}`.trim());
    capture(value);
    wrap.appendChild(value);
    return wrap;
  }

  private buildMenu(): void {
    const add = (label: string, fn: () => void): HTMLButtonElement => {
      const b = button(label, () => {
        this.menuEl.classList.add('hidden');
        fn();
      });
      this.menuEl.appendChild(b);
      return b;
    };
    add('📒  Finances', () => this.toggleFinances());
    this.menuEl.appendChild(document.createElement('hr'));
    add('💾  Save now', () => this.callbacks.saveNow());
    add('📤  Export save file', () => this.callbacks.exportSave());
    add('📥  Import save file', () => this.pickImportFile());
    this.menuEl.appendChild(document.createElement('hr'));
    const skyBtn = add(skyLabel(), () => {
      setSkyMode(skyMode() === 'realWorld' ? 'simClock' : 'realWorld');
      skyBtn.textContent = skyLabel();
      this.toast(
        skyMode() === 'realWorld'
          ? 'Sky now follows your real local time and weather.'
          : 'Sky now follows the in-game clock (weather stays real).',
        'info',
      );
      this.menuEl.classList.remove('hidden'); // keep open to show the change
    });
    this.menuEl.appendChild(document.createElement('hr'));
    add('❓  Help', () => this.toggleHelp());
    add('🏗️  New tower…', () => {
      if (confirm('Start a brand new tower? Your current save will be overwritten.')) {
        this.callbacks.newTower();
      }
    });

    function skyLabel(): string {
      return skyMode() === 'realWorld' ? '🌍  Sky: real local time' : '🕐  Sky: in-game clock';
    }
  }

  private buildDock(): void {
    const dock = el('div', 'dock panel');
    this.tooltipEl = el('div', 'tooltipcard panel hidden');
    this.root.appendChild(this.tooltipEl);

    const groups: TileSpec[][] = [
      [
        { tool: { kind: 'inspect' }, icon: '🔍', name: 'Inspect', star: 1, hotkey: 'Q', tip: 'Click anything to see details. Drag empty space to pan the camera.' },
        { tool: { kind: 'demolish' }, icon: '🧨', name: 'Demolish', star: 1, hotkey: 'X', tip: 'Remove rooms, transport or bare structure. No refunds!' },
      ],
      [
        { tool: { kind: 'floor' }, icon: '🧱', name: 'Floor', star: 1, hotkey: 'F', tip: 'Bare structure — drag horizontally. Rooms build their own floor automatically; use this for corridors and elevator landings.' },
        { tool: { kind: 'stairs' }, icon: '🪜', name: 'Stairs', price: 500, star: 1, hotkey: 'T', tip: 'Connects two floors. People climb at most 4 flights per trip.' },
        { tool: { kind: 'escalator' }, icon: '🎢', name: 'Escalator', price: 2000, star: 2, hotkey: 'R', tip: 'Fast link between two floors. Great for retail traffic.' },
        { tool: { kind: 'elevator' }, icon: '🛗', name: 'Elevator', price: 4000, star: 1, hotkey: 'E', tip: 'Drag vertically to set the range. Comes with 2 cars; add more from its info panel. Builds its own landings through existing floors.' },
      ],
      ROOM_ORDER.map((type) => {
        const def = ROOM_CATALOG[type];
        return {
          tool: { kind: 'room' as const, type },
          icon: ROOM_ICONS[type],
          name: ROOM_SHORT[type] ?? def.name,
          price: def.cost,
          star: def.starRequired,
          tip: def.desc,
        };
      }),
    ];

    for (const group of groups) {
      const g = el('div', 'group');
      for (const spec of group) {
        g.appendChild(this.makeTile(spec));
      }
      dock.appendChild(g);
    }
    this.root.appendChild(dock);
  }

  private makeTile(spec: TileSpec): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'tile';
    const icon = el('span', 'icon', spec.icon);
    const name = el('span', 'name', spec.name);
    b.append(icon, name);
    if (spec.price !== undefined) b.appendChild(el('span', 'price', fmtPrice(spec.price)));
    if (spec.hotkey) b.appendChild(el('span', 'key', spec.hotkey));
    b.addEventListener('click', () => {
      if (b.disabled) return;
      this.app.tool = spec.tool;
      this.refreshToolbar();
      sound.play('click');
    });
    b.addEventListener('mouseenter', () => this.showTooltip(spec));
    b.addEventListener('mouseleave', () => this.tooltipEl.classList.add('hidden'));
    this.toolTiles.push({ el: b, tool: spec.tool, starRequired: spec.star });
    return b;
  }

  private showTooltip(spec: TileSpec): void {
    const locked = spec.star > this.app.state.stars.rating;
    this.tooltipEl.innerHTML = `
      <h4>${spec.icon} ${escapeHtml(spec.name)}${spec.price !== undefined ? ` <span class="cost">${fmtMoney(spec.price)}</span>` : ''}</h4>
      <div class="desc">${escapeHtml(spec.tip)}</div>
      ${locked ? `<div class="lockline">🔒 Unlocks at ${'★'.repeat(spec.star)} (${STAR_THRESHOLDS[spec.star - 1]} population)</div>` : ''}`;
    this.tooltipEl.classList.remove('hidden');
  }

  private buildGoals(): void {
    this.goalsEl = el('div', 'goals panel hidden');
    this.root.appendChild(this.goalsEl);
  }

  private buildInfoPanel(): void {
    this.infoPanel = el('div', 'info-panel panel hidden');
    this.root.appendChild(this.infoPanel);
  }

  private buildToasts(): void {
    this.toastBox = el('div', 'toasts');
    this.root.appendChild(this.toastBox);
  }

  private buildGhostTip(): void {
    this.ghostTip = el('div', 'ghost-tip hidden');
    this.root.appendChild(this.ghostTip);
  }

  private buildFinances(): void {
    this.financesPanel = el('div', 'finances panel hidden');
    this.root.appendChild(this.financesPanel);
  }

  toggleFinances(): void {
    this.financesPanel.classList.toggle('hidden');
    this.renderFinances();
  }

  private buildHelp(): void {
    this.helpDim = el('div', 'overlay-dim hidden');
    this.helpDim.addEventListener('click', () => this.toggleHelp());
    this.root.appendChild(this.helpDim);
    const help = el('div', 'help panel hidden');
    help.id = 'help-panel';
    help.innerHTML = `
      <h2>🏢 Sim Tower</h2>
      <div class="tagline">Grow a sliver of skyline from one lobby to a five-star vertical city.</div>
      <h3>Getting started</h3>
      <ol>
        <li>Place a <b>Lobby</b> on the ground line — drag more lobbies beside it to widen your entrance.</li>
        <li>Add <b>Offices</b> on the floors above (they build their own structure).</li>
        <li>Drag an <b>Elevator</b> from the lobby up past your offices — it builds its own landings.</li>
        <li>Tenants move in through the day. Rent lands every 4th day. Build more!</li>
      </ol>
      <h3>How money works</h3>
      <ul>
        <li><b>Offices</b> pay rent quarterly · <b>Condos</b> sell once for cash · <b>Hotels</b> earn nightly (need Housekeeping) · <b>Retail</b> earns per customer visit.</li>
        <li>Rooms with a red ⚠ have no route people can actually travel (elevators/stairs to a lobby) — they earn nothing.</li>
        <li>Long elevator queues make tenants miserable; unhappy tenants leave. Watch the 😊 Mood overlay.</li>
      </ul>
      <h3>Controls</h3>
      <div class="keys">
        <span><kbd>Space</kbd> pause</span>
        <span><kbd>1</kbd>–<kbd>3</kbd> speed</span>
        <span><kbd>Q</kbd>/<kbd>Esc</kbd> inspect</span>
        <span><kbd>X</kbd> demolish</span>
        <span><kbd>F</kbd> floor</span>
        <span><kbd>T</kbd> stairs</span>
        <span><kbd>R</kbd> escalator</span>
        <span><kbd>E</kbd> elevator</span>
        <span><kbd>G</kbd> recenter on tower</span>
        <span><kbd>H</kbd> this help</span>
        <span>Right-drag · pan</span>
        <span>Wheel · zoom</span>
      </div>
      <h3>Stars</h3>
      <ul>
        <li>Population milestones (${STAR_THRESHOLDS.slice(1).join(', ')}) raise your star rating, unlocking new rooms and taller towers.</li>
      </ul>
      <div class="footnote">The sky mirrors your real local weather and daylight (cosmetic only — allow location for accuracy, or switch it to the in-game clock from the ☰ menu).</div>
      <button class="primary" id="help-close">Let's build</button>`;
    this.root.appendChild(help);
    help.querySelector('#help-close')!.addEventListener('click', () => this.toggleHelp());
  }

  toggleHelp(): void {
    this.root.querySelector('#help-panel')!.classList.toggle('hidden');
    this.helpDim.classList.toggle('hidden');
  }

  /** Close transient overlays (Esc). Returns true if something closed. */
  closeOverlays(): boolean {
    let closed = false;
    const help = this.root.querySelector('#help-panel')!;
    if (!help.classList.contains('hidden')) {
      this.toggleHelp();
      closed = true;
    }
    if (!this.menuEl.classList.contains('hidden')) {
      this.menuEl.classList.add('hidden');
      closed = true;
    }
    return closed;
  }

  // ------------------------------------------------------------------ updates

  /** Called every render frame; throttles its own DOM writes. */
  update(nowMs: number): void {
    if (nowMs - this.lastStatsUpdate < 120) return;
    this.lastStatsUpdate = nowMs;
    const s = this.app.state;

    // Money: eased count + pulse on change.
    if (this.displayedMoney === null) this.displayedMoney = s.money;
    if (this.lastMoney === null) this.lastMoney = s.money;
    if (Math.abs(s.money - this.lastMoney) > 0.5) {
      const up = s.money > this.lastMoney;
      this.moneyEl.classList.remove('pulse-up', 'pulse-down');
      void this.moneyEl.offsetWidth; // restart the animation
      this.moneyEl.classList.add(up ? 'pulse-up' : 'pulse-down');
      this.lastMoney = s.money;
    }
    this.displayedMoney += (s.money - this.displayedMoney) * 0.35;
    if (Math.abs(this.displayedMoney - s.money) < 1) this.displayedMoney = s.money;
    this.moneyEl.textContent = fmtMoney(this.displayedMoney);
    this.moneyEl.classList.toggle('negative', s.money < 0);

    this.popEl.textContent = `👥 ${s.population.toLocaleString()}`;
    const rating = s.stars.rating;
    const next = STAR_THRESHOLDS[rating] ?? null;
    const prev = STAR_THRESHOLDS[rating - 1] ?? 0;
    const pct = next === null ? 100 : Math.min(100, ((s.population - prev) / (next - prev)) * 100);
    this.starProgressEl.style.width = `${Math.max(2, pct)}%`;

    this.starEl.innerHTML =
      '★'.repeat(rating) + `<span class="off">${'★'.repeat(5 - rating)}</span>`;

    const c = clockOf(s.minutes);
    this.clockLabelEl.textContent = `Day ${c.day + 1} · ${WEEKDAY_NAMES[c.dayOfWeek]}${c.isWeekend ? ' · weekend' : ''}`;
    this.clockEl.textContent = `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')} ${c.isNight ? '🌙' : '☀️'}`;

    this.renderGoals();
    this.renderInfoPanel();
    this.renderFinances();
  }

  refresh(): void {
    this.refreshToolbar();
    this.refreshSpeed();
    this.renderInfoPanel();
  }

  private refreshSpeed(): void {
    this.speedButtons.forEach((b, i) => b.classList.toggle('active', this.app.state.speed === i));
  }

  private refreshToolbar(): void {
    const rating = this.app.state.stars.rating;
    for (const tb of this.toolTiles) {
      const locked = tb.starRequired > rating;
      tb.el.disabled = locked;
      tb.el.classList.toggle('locked', locked);
      tb.el.classList.toggle('active', sameTool(tb.tool, this.app.tool));
      let lock = tb.el.querySelector('.lock');
      if (locked && !lock) {
        lock = el('span', 'lock', `★${tb.starRequired}`);
        tb.el.appendChild(lock);
      } else if (!locked && lock) {
        lock.remove();
      }
    }
  }

  setWeather(w: WeatherDescriptor | null): void {
    if (!w) {
      this.weatherEl.textContent = '';
      return;
    }
    const icon = { clear: w.isNight ? '🌙' : '☀️', cloudy: '☁️', rain: '🌧️', snow: '🌨️' }[w.condition];
    this.weatherEl.textContent = `${icon}${w.source === 'live' ? ' 📍' : ''}`;
    this.weatherEl.title =
      `Backdrop: ${w.condition}, ${w.isNight ? 'night' : 'day'} — cosmetic only` +
      (w.source === 'live' ? ' (your real local weather)' : ' (default — allow location for live weather)');
  }

  showGhost(info: GhostInfo | null): void {
    if (!info) {
      this.ghostTip.classList.add('hidden');
      return;
    }
    this.ghostTip.classList.remove('hidden');
    this.ghostTip.textContent = info.text;
    this.ghostTip.classList.toggle('bad', !info.ok);
    const flipX = info.screenX > window.innerWidth - 240;
    this.ghostTip.style.left = flipX ? `${info.screenX - 220}px` : `${info.screenX + 16}px`;
    this.ghostTip.style.top = `${info.screenY + 22}px`;
  }

  // ------------------------------------------------------------------- goals

  private renderGoals(): void {
    if (this.goalsDismissed) {
      this.goalsEl.classList.add('hidden');
      return;
    }
    const s = this.app.state;
    const goals = [
      { label: 'Place a Lobby on the ground line', done: s.rooms.some((r) => r.type === 'lobby') },
      { label: 'Build an Office on a floor above', done: s.rooms.some((r) => r.type === 'office') },
      { label: 'Connect floors (Elevator or Stairs)', done: s.transports.length > 0 },
      { label: 'First tenant moves in', done: s.rooms.some((r) => r.occupied && ['office', 'residence'].includes(ROOM_CATALOG[r.type].category)) },
      { label: 'Collect your first income', done: s.ledger.some((e) => e.amount > 0) },
    ];
    const allDone = goals.every((g) => g.done);
    const rating = s.stars.rating;
    const next = STAR_THRESHOLDS[rating] ?? null;

    const signature = goals.map((g) => (g.done ? '1' : '0')).join('') + `:${rating}:${next === null ? 'max' : Math.floor(((s.population) / next) * 50)}`;
    if (signature === this.goalsSignature) return;
    this.goalsSignature = signature;

    const rows: string[] = [];
    rows.push(`<h4><span>${allDone ? 'Next milestone' : 'Getting started'}</span><button id="goals-x" title="Hide">✕</button></h4>`);
    if (!allDone) {
      for (const g of goals) {
        rows.push(
          `<div class="item ${g.done ? 'done' : ''}"><span class="tick">${g.done ? '✔' : '○'}</span><span>${g.label}</span></div>`,
        );
      }
    }
    if (next !== null) {
      const prev = STAR_THRESHOLDS[rating - 1] ?? 0;
      const pct = Math.min(100, ((s.population - prev) / (next - prev)) * 100);
      rows.push(
        `<div class="nextstar">${'★'.repeat(rating + 1)} at <b>${next.toLocaleString()}</b> population (now ${s.population.toLocaleString()})<div class="progress"><div style="width:${Math.max(2, pct)}%"></div></div></div>`,
      );
    } else if (allDone) {
      rows.push(`<div class="nextstar">⭐ Five stars — the skyline is yours.</div>`);
    }
    this.goalsEl.innerHTML = rows.join('');
    this.goalsEl.classList.remove('hidden');
    this.goalsEl.querySelector('#goals-x')!.addEventListener('click', () => {
      this.goalsDismissed = true;
      this.goalsEl.classList.add('hidden');
      try {
        localStorage.setItem(GOALS_KEY, '1');
      } catch {
        /* fine */
      }
    });
  }

  // -------------------------------------------------------------- info panel

  /**
   * The panel skeleton (incl. buttons) is rebuilt only when its structural
   * signature changes; volatile numbers update in place. Rebuilding every
   * refresh would destroy buttons between mousedown and mouseup, eating
   * clicks.
   */
  private renderInfoPanel(): void {
    const sel = this.app.selection;
    if (!sel) {
      this.infoPanel.classList.add('hidden');
      this.infoSignature = '';
      return;
    }
    const s = this.app.state;
    const room = sel.kind === 'room' ? s.rooms.find((r) => r.id === sel.id) : undefined;
    const transport = sel.kind === 'transport' ? s.transports.find((t) => t.id === sel.id) : undefined;
    if (!room && !transport) {
      this.app.selection = null;
      this.infoPanel.classList.add('hidden');
      this.infoSignature = '';
      return;
    }
    this.infoPanel.classList.remove('hidden');

    if (room) {
      this.renderRoomInfo(room);
    } else if (transport) {
      const t = transport;
      if (t.type === 'elevator') {
        const signature = `t:${t.id}:${t.cars?.length ?? 0}:${t.yMin}:${t.yMax}`;
        if (signature !== this.infoSignature) {
          this.infoSignature = signature;
          this.infoPanel.innerHTML = `
            <div class="head"><span class="icon">🛗</span><div><h3>Elevator</h3>
            <div class="sub">Floors ${floorName(t.yMin)} to ${floorName(t.yMax)}</div></div></div>
            <div class="body">
              <div class="kv"><span>Cars</span><b>${t.cars?.length ?? 0} / ${MAX_CARS_PER_SHAFT}</b></div>
              <div class="kv"><span>Waiting now</span><b id="elev-waiting"></b></div>
              <div class="btn-row" id="elev-actions"></div>
            </div>`;
          const actions = this.infoPanel.querySelector('#elev-actions')!;
          actions.appendChild(
            button('➕ Add car — $1,000', () => this.issueToast({ kind: 'AddElevatorCar', transportId: t.id })),
          );
          actions.appendChild(
            button('⬆ Extend top +1 floor', () =>
              this.issueToast({ kind: 'ExtendElevator', transportId: t.id, yMin: t.yMin, yMax: t.yMax + 1 }),
            ),
          );
          actions.appendChild(
            button('⬇ Extend bottom −1 floor', () =>
              this.issueToast({ kind: 'ExtendElevator', transportId: t.id, yMin: t.yMin - 1, yMax: t.yMax }),
            ),
          );
          const demo = button('🧨 Demolish shaft', () => {
            this.issueToast({ kind: 'Demolish', x: t.x, y: t.yMin });
          });
          demo.classList.add('danger');
          actions.appendChild(demo);
        }
        const waiting = s.people.filter(
          (p) => p.phase.kind === 'waitingElevator' && p.phase.transportId === t.id,
        ).length;
        setText(this.infoPanel, 'elev-waiting', String(waiting));
      } else {
        const signature = `t:${t.id}`;
        if (signature !== this.infoSignature) {
          this.infoSignature = signature;
          const isStairs = t.type === 'stairs';
          this.infoPanel.innerHTML = `
            <div class="head"><span class="icon">${isStairs ? '🪜' : '🎢'}</span><div>
            <h3>${isStairs ? 'Stairs' : 'Escalator'}</h3>
            <div class="sub">Floors ${floorName(t.yMin)}–${floorName(t.yMax)}</div></div></div>
            <div class="body"><div class="btn-row" id="st-actions"></div></div>`;
          const actions = this.infoPanel.querySelector('#st-actions')!;
          const demo = button('🧨 Demolish', () => this.issueToast({ kind: 'Demolish', x: t.x, y: t.yMin }));
          demo.classList.add('danger');
          actions.appendChild(demo);
        }
      }
    }
  }

  private renderRoomInfo(room: Room): void {
    const def = ROOM_CATALOG[room.type];
    const rated = ['office', 'residence', 'hotel'].includes(def.category);
    const signature = `room:${room.id}:${room.occupied}:${room.occupants}:${room.reachable}:${room.hotel?.state ?? ''}:${room.noisePenalty > 0}`;
    if (signature !== this.infoSignature) {
      this.infoSignature = signature;
      const rows: string[] = [
        `<div class="head"><span class="icon">${ROOM_ICONS[room.type]}</span><div>
         <h3>${def.name}</h3><div class="sub">Floor ${floorName(room.y)}</div></div></div>`,
        `<div class="body">`,
        `<div>${room.reachable ? '<span class="chip ok">✓ Connected</span>' : '<span class="chip err">⚠ No route to lobby</span>'}${room.noisePenalty > 0 ? ' <span class="chip warn">🔊 Noisy neighbours</span>' : ''}</div>`,
      ];
      if (rated) {
        rows.push(`<div class="kv"><span>Status</span><b>${room.occupied ? `Occupied · ${room.occupants || def.people} people` : 'Vacant'}</b></div>`);
        rows.push(meter('Satisfaction', 'ip-sat'));
        rows.push(`<div class="kv"><span>Avg elevator wait</span><b><span id="ip-wait"></span> min</b></div>`);
      }
      if (room.hotel) {
        rows.push(`<div class="kv"><span>Room state</span><b id="ip-hotel">${room.hotel.state}</b></div>`);
      }
      if (room.retail) {
        rows.push(`<div class="kv"><span>Visits today</span><b id="ip-visits"></b></div>`);
        rows.push(meter('Appeal', 'ip-appeal'));
      }
      if (def.rentPerQuarter) rows.push(`<div class="kv"><span>Rent</span><b>${fmtMoney(def.rentPerQuarter)} / quarter</b></div>`);
      if (def.nightlyRate) rows.push(`<div class="kv"><span>Nightly rate</span><b>${fmtMoney(def.nightlyRate)}</b></div>`);
      if (def.upkeepPerQuarter) rows.push(`<div class="kv"><span>Upkeep</span><b>${fmtMoney(def.upkeepPerQuarter)} / quarter</b></div>`);
      rows.push(`<div class="btn-row" id="room-actions"></div>`);
      rows.push(`</div>`);
      this.infoPanel.innerHTML = rows.join('');
      const actions = this.infoPanel.querySelector('#room-actions')!;
      const demo = button('🧨 Demolish', () => {
        if (room.occupied && rated && !confirm(`${def.name} has tenants. Demolish anyway?`)) return;
        this.issueToast({ kind: 'Demolish', x: room.x, y: room.y });
      });
      demo.classList.add('danger');
      actions.appendChild(demo);
    }
    if (rated) {
      setMeter(this.infoPanel, 'ip-sat', room.satisfaction);
      setText(this.infoPanel, 'ip-wait', room.avgWait.toFixed(1));
    }
    if (room.retail) {
      setText(this.infoPanel, 'ip-visits', `${room.retail.visitsToday} (+${fmtMoney(room.retail.incomeToday)})`);
      setMeter(this.infoPanel, 'ip-appeal', room.satisfaction);
    }
  }

  private issueToast(cmd: Parameters<GameApp['issue']>[0]): void {
    const r = this.app.issue(cmd);
    if (!r.ok) {
      this.toast(FAILURE_MESSAGES[r.reason], 'bad');
      sound.play('error');
    } else {
      sound.play(cmd.kind === 'Demolish' ? 'demolish' : 'build');
    }
  }

  private renderFinances(): void {
    if (this.financesPanel.classList.contains('hidden')) return;
    const s = this.app.state;
    const today = clockOf(s.minutes).day;
    const todayNet = s.ledger.filter((e) => e.day === today).reduce((sum, e) => sum + e.amount, 0);
    const entries = [...s.ledger].reverse().slice(0, 30);
    this.financesPanel.innerHTML =
      `<div class="head"><h3>📒 Finances</h3><span class="net">today <span class="${todayNet < 0 ? 'neg' : 'pos'}">${todayNet < 0 ? '−' : '+'}${fmtMoney(Math.abs(todayNet))}</span></span></div>` +
      `<div class="rows">` +
      (entries.length === 0
        ? '<div class="ledger-row"><span class="lbl">No transactions yet.</span></div>'
        : entries
            .map(
              (e) =>
                `<div class="ledger-row"><span class="day">D${e.day + 1}</span><span class="lbl">${escapeHtml(e.label)}</span><span class="${e.amount < 0 ? 'neg' : 'pos'}">${e.amount < 0 ? '−' : '+'}${fmtMoney(Math.abs(e.amount))}</span></div>`,
            )
            .join('')) +
      `</div>`;
  }

  // ------------------------------------------------------------------ events

  onEvents(events: SimEvent[]): void {
    let cash = false;
    for (const e of events) {
      switch (e.kind) {
        case 'starUp':
          this.toast(
            `⭐ ${e.rating} STARS! Unlocked: ${e.unlocked.map((u) => ROOM_CATALOG[u].name).join(', ') || 'taller towers'}`,
            'star',
          );
          sound.play('star');
          this.refreshToolbar();
          break;
        case 'quarter':
          this.toast(
            `📊 Quarter ${e.quarterIndex}: rent +${fmtMoney(e.income)}, upkeep −${fmtMoney(e.expenses)} (net ${e.net >= 0 ? '+' : '−'}${fmtMoney(Math.abs(e.net))})`,
            e.net >= 0 ? 'good' : 'bad',
          );
          if (e.income > 0) cash = true;
          break;
        case 'condoSold':
          this.toast(`🏠 Condo sold: +${fmtMoney(e.price)}`, 'good');
          cash = true;
          break;
        case 'moveIn':
          this.toast(`🎉 New tenant: ${ROOM_CATALOG[e.roomType].name}`, 'good');
          sound.play('movein');
          break;
        case 'moveOut':
          this.toast(`📦 ${ROOM_CATALOG[e.roomType].name} moved out (${e.reason})`, 'bad');
          sound.play('moveout');
          break;
        case 'hotelNight':
          this.toast(`🛏️ ${e.guests} hotel guests checked out: +${fmtMoney(e.income)}`, 'good');
          cash = true;
          break;
        case 'retailDay':
          if (e.income > 0) this.toast(`🛍️ Retail: ${e.visits} customers, +${fmtMoney(e.income)}`, 'good');
          if (e.income > 0) cash = true;
          break;
        case 'day':
          break;
      }
    }
    if (cash) sound.play('cash');
  }

  toast(text: string, kind: 'info' | 'good' | 'bad' | 'star'): void {
    const t = el('div', `toast ${kind}`, text);
    this.toastBox.appendChild(t);
    setTimeout(() => t.classList.add('shown'), 15);
    setTimeout(() => {
      t.classList.remove('shown');
      setTimeout(() => t.remove(), 400);
    }, kind === 'star' ? 8000 : 4200);
    while (this.toastBox.children.length > 4) this.toastBox.firstChild?.remove();
  }

  private pickImportFile(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return;
      void file.text().then((text) => this.callbacks.importSave(text));
    });
    input.click();
  }
}

// ---------------------------------------------------------------- helpers

function floorName(y: number): string {
  return y >= 0 ? `${y}` : `B${-y}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(label: string, onClick: () => void, tip?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  if (tip) b.title = tip;
  b.addEventListener('click', onClick);
  return b;
}

/** Meter skeleton whose bar/number update in place via setMeter(). */
function meter(label: string, id: string): string {
  return `<div class="meter"><span>${label}</span><div class="bar"><div id="${id}-bar"></div></div><span class="num" id="${id}-num"></span></div>`;
}

function setMeter(rootEl: HTMLElement, id: string, value: number): void {
  const pct = Math.round(Math.max(0, Math.min(100, value)));
  const hue = Math.round((pct / 100) * 120);
  const bar = rootEl.querySelector<HTMLElement>(`#${id}-bar`);
  const num = rootEl.querySelector<HTMLElement>(`#${id}-num`);
  if (bar) {
    bar.style.width = `${pct}%`;
    bar.style.background = `hsl(${hue},70%,50%)`;
  }
  if (num) num.textContent = String(pct);
}

function setText(rootEl: HTMLElement, id: string, text: string): void {
  const node = rootEl.querySelector<HTMLElement>(`#${id}`);
  if (node && node.textContent !== text) node.textContent = text;
}

function sameTool(a: Tool, b: Tool): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'room' && b.kind === 'room') return a.type === b.type;
  return true;
}
