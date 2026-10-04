import type { AccelSample } from '@tele/engine';

export interface Sensor { start(cb: (s: AccelSample) => void): void; stop(): void }

/** iOS requires an explicit permission request from inside a tap handler. */
export async function requestMotionPermission(): Promise<'granted' | 'denied' | 'unsupported'> {
  const DME = (window as any).DeviceMotionEvent;
  if (!DME) return 'unsupported';
  if (typeof DME.requestPermission === 'function') { try { return (await DME.requestPermission()) === 'granted' ? 'granted' : 'denied'; } catch { return 'denied'; } }
  return 'granted';
}

export class RealSensor implements Sensor {
  private h?: (e: DeviceMotionEvent) => void;
  start(cb: (s: AccelSample) => void) {
    this.h = (e) => { const a = e.accelerationIncludingGravity; if (a && a.x != null && a.y != null && a.z != null) cb({ ax: a.x, ay: a.y, az: a.z, t: performance.now() }); };
    window.addEventListener('devicemotion', this.h);
  }
  stop() { if (this.h) window.removeEventListener('devicemotion', this.h); }
}

/** Demo sensor for a laptop: emits gravity vectors for a chosen segment angle, with noise, through the SAME engine code path. */
export class SimSensor implements Sensor {
  private id?: number;
  constructor(private angle: () => number) {}
  start(cb: (s: AccelSample) => void) {
    const n = () => (Math.random() - 0.5) * 0.12;
    this.id = window.setInterval(() => { const p = (this.angle() * Math.PI) / 180; cb({ ax: 9.81 * Math.sin(p) + n(), ay: 9.81 * Math.cos(p) + n(), az: 0.3 + n(), t: performance.now() }); }, 20);
  }
  stop() { if (this.id) clearInterval(this.id); }
}
