/**
 * Transient view effects: floating money/text, celebration bursts, demolish
 * puffs. Pooled Phaser Texts + one particle emitter; world-space so effects
 * anchor to the rooms that earned them. Pure view — reads nothing back.
 */
import Phaser from 'phaser';

const POOL_LIMIT = 24;

export class EffectsLayer {
  private pool: Phaser.GameObjects.Text[] = [];
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private puffs: Phaser.GameObjects.Particles.ParticleEmitter;

  constructor(private scene: Phaser.Scene) {
    const g = scene.add.graphics();
    g.fillStyle(0xffffff, 1).fillRect(0, 0, 3, 3).generateTexture('fx-dot', 3, 3);
    g.destroy();
    this.sparks = scene.add
      .particles(0, 0, 'fx-dot', {
        speed: { min: 60, max: 190 },
        angle: { min: 0, max: 360 },
        gravityY: 240,
        lifespan: { min: 380, max: 820 },
        scale: { start: 1.4, end: 0 },
        tint: [0xffd76a, 0xffb347, 0xfff3c4],
        emitting: false,
      })
      .setDepth(42);
    this.puffs = scene.add
      .particles(0, 0, 'fx-dot', {
        speed: { min: 20, max: 70 },
        angle: { min: 200, max: 340 },
        lifespan: { min: 300, max: 650 },
        scale: { start: 1.8, end: 0 },
        alpha: { start: 0.8, end: 0 },
        tint: [0x8a93a5, 0x5d6474],
        emitting: false,
      })
      .setDepth(42);
  }

  floatText(worldX: number, worldY: number, str: string, color: string): void {
    const text = this.acquire();
    text
      .setText(str)
      .setColor(color)
      .setPosition(worldX, worldY)
      .setAlpha(0)
      .setScale(0.8)
      .setActive(true)
      .setVisible(true);
    this.scene.tweens.add({
      targets: text,
      y: worldY - 34,
      alpha: { from: 1, to: 0 },
      scale: 1,
      ease: 'Cubic.easeOut',
      duration: 1500,
      onComplete: () => this.release(text),
    });
  }

  /** Golden celebration burst (star-ups, big sales). */
  burst(worldX: number, worldY: number, count = 26): void {
    this.sparks.explode(count, worldX, worldY);
  }

  /** Grey dust when something is demolished. */
  puff(worldX: number, worldY: number, count = 14): void {
    this.puffs.explode(count, worldX, worldY);
  }

  private acquire(): Phaser.GameObjects.Text {
    const idle = this.pool.find((t) => !t.active);
    if (idle) return idle;
    const text = this.scene.add
      .text(0, 0, '', {
        fontFamily: "'Segoe UI', system-ui, sans-serif",
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#ffffff',
      })
      .setOrigin(0.5, 1)
      .setDepth(44)
      .setStroke('#0a0e16', 3);
    if (this.pool.length < POOL_LIMIT) this.pool.push(text);
    return text;
  }

  private release(text: Phaser.GameObjects.Text): void {
    // Pooled texts are parked for reuse; overflow texts (beyond POOL_LIMIT,
    // created during a burst) are destroyed so they can't accumulate.
    if (this.pool.includes(text)) {
      text.setActive(false).setVisible(false);
    } else {
      text.destroy();
    }
  }
}
