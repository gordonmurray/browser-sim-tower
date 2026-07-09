/**
 * Tiny WebAudio synth for UI feedback: no assets, a few dozen ms of envelope
 * per cue. Autoplay-safe (context resumes on first gesture), mute persisted
 * outside the save. View-layer only.
 */
const MUTE_KEY = 'browser-sim-tower.muted';

export type Cue =
  | 'click'
  | 'build'
  | 'demolish'
  | 'error'
  | 'cash'
  | 'star'
  | 'movein'
  | 'moveout';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private lastPlayed = new Map<Cue, number>();
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      this.muted = false;
    }
    const unlock = () => {
      this.ensure();
      void this.ctx?.resume();
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    try {
      localStorage.setItem(MUTE_KEY, this.muted ? '1' : '0');
    } catch {
      /* preference just won't persist */
    }
    return this.muted;
  }

  private ensure(): void {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.16;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.22);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    } catch {
      this.ctx = null; // no audio available — play silently forever
    }
  }

  play(cue: Cue): void {
    if (this.muted) return;
    this.ensure();
    if (!this.ctx || !this.master || this.ctx.state !== 'running') return;
    // Debounce identical cues so event bursts don't stack into noise.
    const now = performance.now();
    const gap = cue === 'click' ? 30 : 90;
    if (now - (this.lastPlayed.get(cue) ?? -1e9) < gap) return;
    this.lastPlayed.set(cue, now);

    const t = this.ctx.currentTime;
    switch (cue) {
      case 'click':
        this.tone('triangle', 1500, t, 0.045, 0.1);
        break;
      case 'build':
        this.thump(t, 110, 0.5);
        this.tone('triangle', 330, t + 0.02, 0.08, 0.12);
        break;
      case 'demolish':
        this.noise(t, 0.2, 500, 0.4);
        this.thump(t, 70, 0.5);
        break;
      case 'error':
        this.tone('sawtooth', 170, t, 0.13, 0.16, 115);
        break;
      case 'cash':
        this.tone('sine', 660, t, 0.07, 0.22);
        this.tone('sine', 990, t + 0.07, 0.1, 0.2);
        break;
      case 'star':
        [523, 659, 784, 1047].forEach((f, i) => {
          this.tone('sine', f, t + i * 0.09, 0.24, 0.2);
          this.tone('triangle', f * 2, t + i * 0.09, 0.12, 0.05);
        });
        break;
      case 'movein':
        this.tone('sine', 520, t, 0.07, 0.14);
        this.tone('sine', 780, t + 0.06, 0.08, 0.12);
        break;
      case 'moveout':
        this.tone('sine', 420, t, 0.09, 0.12, 300);
        break;
    }
  }

  private tone(
    type: OscillatorType,
    freq: number,
    at: number,
    dur: number,
    peak: number,
    glideTo?: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, at);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, at + dur);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0008, at + dur);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + dur + 0.03);
  }

  private thump(at: number, freq: number, peak: number): void {
    if (!this.ctx || !this.master) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2.2, at);
    osc.frequency.exponentialRampToValueAtTime(freq, at + 0.09);
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.16);
    osc.connect(gain).connect(this.master);
    osc.start(at);
    osc.stop(at + 0.2);
  }

  private noise(at: number, dur: number, cutoff: number, peak: number): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.001, at + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(at);
    src.stop(at + dur + 0.02);
  }
}

export const sound = new SoundEngine();
