// 소리: 피아노(훈련 음색)와 기타(테스트용 낯선 음색)는 녹음 샘플(web/sounds/<악기>/<MIDI>.wav,
// tools/build-piano.ts·build-guitar.ts로 만듦), 셰퍼드 톤과 볼륨 확인용 잡음은 브라우저에서 합성한다.

import type { Timbre } from './protocol.ts';

export interface Playback {
  onset: number; // 소리가 스피커에서 나오기 시작하는 performance.now() 시각
  end: number;
}

const SAMPLE_LOW = 60;  // C4
const SAMPLE_HIGH = 95; // B6
const SHEPARD_SEC = 20;
const TAU = 2 * Math.PI;

let ctx: AudioContext | null = null;
let out: GainNode | null = null;
const cache = new Map<string, AudioBuffer>();
const loading = new Map<Timbre, Promise<void>>();
const playing = new Set<AudioBufferSourceNode>();
let shepard: AudioBuffer | null = null;
let noise: AudioBuffer | null = null;

export function unlock(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext({ latencyHint: 'interactive' });
    out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(ctx.destination);
    load('piano').catch(() => {}); // 실패하면 소리가 필요한 순간에 다시 시도한다
  }
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

// 한 악기의 샘플 36개(C4–B6)를 받아 디코딩해 둔다
export function load(timbre: Timbre): Promise<void> {
  let done = loading.get(timbre);
  if (!done) {
    done = Promise.all(
      Array.from({ length: SAMPLE_HIGH - SAMPLE_LOW + 1 }, async (_, k) => {
        const midi = SAMPLE_LOW + k;
        const res = await fetch(`sounds/${timbre}/${midi}.wav`);
        if (!res.ok) throw new Error(`${timbre} ${midi}: ${res.status}`);
        cache.set(`${timbre}:${midi}`, await unlock().decodeAudioData(await res.arrayBuffer()));
      }),
    ).then(() => undefined);
    done.catch(() => loading.delete(timbre));
    loading.set(timbre, done);
  }
  return done;
}

export function noteBuffer(timbre: Timbre, midi: number): AudioBuffer {
  const buffer = cache.get(`${timbre}:${midi}`);
  if (!buffer) throw new Error(`샘플이 아직 없어요: ${timbre} ${midi} (load를 먼저 기다려야 함)`);
  return buffer;
}

// 시작·끝 페이드를 주고 RMS를 맞춘다
function finish(buf: Float64Array, sr: number, fadeSec: number, rms: number): Float32Array<ArrayBuffer> {
  const f = Math.round(fadeSec * sr);
  const n = buf.length;
  for (let i = 0; i < f; i++) {
    buf[i] *= i / f;
    buf[n - 1 - i] *= i / f;
  }
  let s = 0;
  for (let i = 0; i < n; i++) s += buf[i] * buf[i];
  const g = rms / Math.sqrt(s / n || 1);
  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) result[i] = buf[i] * g;
  return result;
}

// 계속 내려가는 셰퍼드-리셋 글리산도 (5초에 한 옥타브)
function renderShepard(sr: number): Float32Array<ArrayBuffer> {
  const n = SHEPARD_SEC * sr;
  const buf = new Float64Array(n);
  const comps = 10;
  const fLow = 20;
  const center = Math.log2(600 / fLow);
  const sigma = 1.5;
  const octavesPerSec = 1 / 5;
  const phase = new Float64Array(comps);
  const block = 128;
  for (let i0 = 0; i0 < n; i0 += block) {
    const t = i0 / sr;
    const end = Math.min(n, i0 + block);
    for (let c = 0; c < comps; c++) {
      const x = (((c - t * octavesPerSec) % comps) + comps) % comps;
      const amp = Math.exp(-((x - center) ** 2) / (2 * sigma * sigma));
      const w = (TAU * fLow * 2 ** x) / sr;
      let ph = phase[c];
      for (let i = i0; i < end; i++) {
        buf[i] += amp * Math.sin(ph);
        ph += w;
      }
      phase[c] = ph % TAU;
    }
  }
  return finish(buf, sr, 0.5, 0.08);
}

// 볼륨 확인용 잡음 (음높이 힌트가 없는 소리)
function renderNoise(sr: number): Float32Array<ArrayBuffer> {
  const buf = new Float64Array(Math.round(1.5 * sr));
  let lp = 0;
  for (let i = 0; i < buf.length; i++) {
    lp += 0.15 * ((Math.random() * 2 - 1) - lp);
    buf[i] = lp;
  }
  return finish(buf, sr, 0.1, 0.1);
}

function toBuffer(data: Float32Array<ArrayBuffer>): AudioBuffer {
  const c = unlock();
  const b = c.createBuffer(1, data.length, c.sampleRate);
  b.copyToChannel(data, 0);
  return b;
}

// 오디오 시계 시각 → 그 소리가 실제로 스피커에서 나오는 performance.now() 시각
function perfTimeOf(c: AudioContext, contextTime: number): number {
  const ts = c.getOutputTimestamp();
  if (ts.performanceTime && ts.contextTime !== undefined) {
    return ts.performanceTime + (contextTime - ts.contextTime) * 1000;
  }
  const latency = ((c.outputLatency || 0) + (c.baseLatency || 0)) * 1000;
  return performance.now() + (contextTime - c.currentTime) * 1000 + latency;
}

function play(buffer: AudioBuffer, delay: number): Playback {
  const c = unlock();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(out!);
  const at = c.currentTime + delay;
  src.start(at);
  playing.add(src);
  src.onended = () => playing.delete(src);
  return { onset: perfTimeOf(c, at), end: perfTimeOf(c, at + buffer.duration) };
}

export const playNote = (timbre: Timbre, midi: number, delay = 0.04): Playback =>
  play(noteBuffer(timbre, midi), delay);

export function playShepard(): Playback {
  shepard ??= toBuffer(renderShepard(unlock().sampleRate));
  return play(shepard, 0.05);
}

export function playNoise(): Playback {
  noise ??= toBuffer(renderNoise(unlock().sampleRate));
  return play(noise, 0.05);
}

// 셰퍼드 톤은 만드는 데 시간이 조금 걸려서 미리 만들어 둔다
export function prepareShepard(): void {
  if (shepard || !ctx) return;
  const c = ctx;
  setTimeout(() => { shepard ??= toBuffer(renderShepard(c.sampleRate)); }, 50);
}

export function stopAll(): void {
  for (const src of playing) {
    try {
      src.stop();
    } catch {
      // 이미 끝난 소리
    }
  }
  playing.clear();
}
