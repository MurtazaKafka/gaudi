/**
 * Small sounds for edits: a tap when a wall goes down, a soft knock when a
 * piece of furniture lands, a click for a door or window, a lighter tick when
 * something is taken away. Made on the spot with Web Audio (no files), quiet,
 * and off with one switch in settings.
 *
 * Only single edits make a sound: opening a project or trying a generated
 * layout changes everything at once and stays silent.
 */
import { usePlanStore } from './store';
import { usePreviewStore } from './preview';

const KEY = 'gaudi-sounds';
let ctx: AudioContext | null = null;

export function soundsOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundsOn(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
  muted = !on;
}

let muted = !soundsOn();

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

export type Sound = 'wall' | 'place' | 'opening' | 'remove';

/** A short struck sound: a pitched body plus a breath of filtered noise. */
export function play(kind: Sound): void {
  if (muted) return;
  const a = audio();
  if (!a) return;
  const t = a.currentTime + 0.005;
  const spec = {
    wall: { f: 190, len: 0.12, noise: 1800, gain: 0.07 },
    place: { f: 120, len: 0.16, noise: 700, gain: 0.09 },
    opening: { f: 640, len: 0.06, noise: 3200, gain: 0.04 },
    remove: { f: 320, len: 0.07, noise: 2400, gain: 0.035 },
  }[kind];
  const out = a.createGain();
  out.gain.value = spec.gain;
  out.connect(a.destination);

  const body = a.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(spec.f * (0.96 + Math.random() * 0.08), t);
  body.frequency.exponentialRampToValueAtTime(spec.f * 0.6, t + spec.len);
  const bodyGain = a.createGain();
  bodyGain.gain.setValueAtTime(0.0001, t);
  bodyGain.gain.exponentialRampToValueAtTime(1, t + 0.004);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + spec.len);
  body.connect(bodyGain).connect(out);
  body.start(t);
  body.stop(t + spec.len + 0.02);

  const n = Math.ceil(a.sampleRate * 0.05);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 3;
  const noise = a.createBufferSource();
  noise.buffer = buf;
  const band = a.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = spec.noise;
  band.Q.value = 1.2;
  const noiseGain = a.createGain();
  noiseGain.gain.value = 0.5;
  noise.connect(band).connect(noiseGain).connect(out);
  noise.start(t);
}

/** Listen to the plan and sound single edits. Returns a stop function. */
export function startEditSounds(): () => void {
  return usePlanStore.subscribe((s, p) => {
    if (muted || usePreviewStore.getState().active) return;
    const dw = s.walls.length - p.walls.length;
    const df = s.furniture.length - p.furniture.length;
    const doo = s.openings.length - p.openings.length;
    const moved = Math.abs(dw) + Math.abs(df) + Math.abs(doo);
    // One thing at a time is an edit; more is a document being swapped in.
    if (moved === 0 || moved > 3) return;
    if (dw < 0 || df < 0 || doo < 0) play('remove');
    else if (df > 0) play('place');
    else if (doo > 0) play('opening');
    else if (dw > 0) play('wall');
  });
}
