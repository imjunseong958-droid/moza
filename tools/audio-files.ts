// 샘플 다듬기 도구(build-piano.ts, build-guitar.ts)가 같이 쓰는 오디오 함수들

export const OUT_RATE = 44100;
export const NOTE_SEC = 0.8;         // 논문 자극 길이
const FADE_IN_SEC = 0.002;
const FADE_OUT_SEC = 0.1;            // 논문: 끝 0.1초 페이드
export const PRE_ROLL_SEC = 0.003;   // 시작점 조금 앞부터 잘라 타건·탄현음을 살린다
const RMS_SEC = 0.3;
const TARGET_RMS = 0.11;             // 모든 악기·음의 처음 0.3초 크기를 여기에 맞춘다
const PEAK_LIMIT = 0.89;

export interface Audio {
  rate: number;
  samples: Float64Array; // 모노, -1..1
}

// 80비트 확장 정밀도 실수 (AIFF 샘플레이트)
function readExtended(buf: Buffer, at: number): number {
  const exp = ((buf[at] & 0x7f) << 8) | buf[at + 1];
  const mantissa = buf.readUInt32BE(at + 2) * 2 ** 32 + buf.readUInt32BE(at + 6);
  return (buf[at] & 0x80 ? -1 : 1) * mantissa * 2 ** (exp - 16383 - 63);
}

// 16·24비트 PCM AIFF를 모노로 읽는다. 앞부분만 받은 파일(잘린 SSND)도 읽을 수 있다.
export function parseAiff(buf: Buffer): Audio {
  if (buf.toString('ascii', 0, 4) !== 'FORM' || buf.toString('ascii', 8, 12) !== 'AIFF') throw new Error('AIFF가 아니에요');
  let channels = 0;
  let bits = 0;
  let rate = 0;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32BE(at + 4);
    const body = at + 8;
    if (id === 'COMM') {
      channels = buf.readInt16BE(body);
      bits = buf.readInt16BE(body + 6);
      rate = readExtended(buf, body + 8);
    } else if (id === 'SSND') {
      data = buf.subarray(body + 8 + buf.readUInt32BE(body), Math.min(buf.length, body + size));
    }
    at = body + size + (size % 2);
  }
  if (!data || (bits !== 16 && bits !== 24) || channels < 1) throw new Error(`지원하지 않는 형식 (채널 ${channels}, ${bits}비트)`);
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += data.readIntBE((i * channels + c) * bytes, bytes);
    samples[i] = s / channels / 2 ** (bits - 1);
  }
  return { rate, samples };
}

export function wav16(samples: Float64Array, rate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write('WAVEfmt ', 8, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);       // PCM
  buf.writeUInt16LE(1, 22);       // 모노
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((v, i) => buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return buf;
}

// 시작 근처 최댓값의 ratio를 처음 넘는 지점에서 PRE_ROLL_SEC 앞 (from부터 within초 안에서 찾는다)
export function attackIndex(x: Float64Array, rate: number, from = 0, within = Infinity, ratio = 0.05): number {
  const end = Math.min(x.length, from + within * rate);
  let peak = 0;
  for (let i = from; i < end; i++) peak = Math.max(peak, Math.abs(x[i]));
  let i = from;
  while (i < end && Math.abs(x[i]) < peak * ratio) i++;
  return Math.max(0, i - Math.round(PRE_ROLL_SEC * rate));
}

const sinc = (t: number) => (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t));

// 윈도 sinc 리샘플링. speed 2면 한 옥타브 위(길이 절반). 출력 length 샘플을 start(원본 인덱스)부터 만든다.
export function resample(src: Audio, outRate: number, start: number, length: number, speed = 1): Float64Array {
  const cutoff = 0.95 * Math.min(src.rate / 2, outRate / (2 * speed)); // 접힘(aliasing) 방지
  const step = src.rate / (2 * cutoff); // 영점 사이 원본 샘플 수
  const half = Math.ceil(16 * step);
  const out = new Float64Array(length);
  for (let n = 0; n < length; n++) {
    const pos = start + (n * speed * src.rate) / outRate;
    const center = Math.floor(pos);
    let s = 0;
    for (let k = center - half + 1; k <= center + half; k++) {
      if (k < 0 || k >= src.samples.length) continue;
      const d = pos - k;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * d) / half) + 0.08 * Math.cos((2 * Math.PI * d) / half); // Blackman
      s += src.samples[k] * sinc(d / step) * w;
    }
    out[n] = s / step;
  }
  return out;
}

export function fade(clip: Float64Array, rate: number): void {
  const a = Math.round(FADE_IN_SEC * rate);
  const r = Math.round(FADE_OUT_SEC * rate);
  for (let i = 0; i < a; i++) clip[i] *= i / a;
  for (let i = 0; i < r; i++) clip[clip.length - 1 - i] *= i / r;
}

// 모든 음의 처음 0.3초 RMS를 TARGET_RMS로 맞춘다. 봉우리가 PEAK_LIMIT를 넘으면 전체를 함께 줄인다.
export function levelAll(clips: Float64Array[], rate: number): void {
  const m = Math.round(RMS_SEC * rate);
  const stats = clips.map((c) => {
    let sq = 0;
    let peak = 0;
    for (let i = 0; i < c.length; i++) {
      if (i < m) sq += c[i] * c[i];
      peak = Math.max(peak, Math.abs(c[i]));
    }
    return { rms: Math.sqrt(sq / m), peak };
  });
  const target = Math.min(TARGET_RMS, ...stats.map((s) => (PEAK_LIMIT * s.rms) / s.peak));
  clips.forEach((c, k) => {
    const g = target / stats[k].rms;
    for (let i = 0; i < c.length; i++) c[i] *= g;
  });
}

// YIN으로 기본 주파수를 잰다. minHz–maxHz 밖이거나 주기성이 약하면 null.
export function yinHz(x: Float64Array, rate: number, minHz: number, maxHz: number): number | null {
  const maxLag = Math.ceil(rate / minHz);
  const minLag = Math.floor(rate / maxHz);
  const w = Math.min(x.length - maxLag - 1, Math.round(0.05 * rate));
  if (w <= 0) return null;
  const d = new Float64Array(maxLag + 2);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i < w; i++) {
      const diff = x[i] - x[i + lag];
      s += diff * diff;
    }
    d[lag] = s;
  }
  let running = 0;
  const cmnd = new Float64Array(maxLag + 2).fill(1);
  for (let lag = 1; lag <= maxLag + 1; lag++) {
    running += d[lag];
    cmnd[lag] = (d[lag] * lag) / (running || 1);
  }
  let lag = -1;
  for (let t = Math.max(2, minLag); t <= maxLag; t++) {
    if (cmnd[t] < 0.15) {
      while (t + 1 <= maxLag && cmnd[t + 1] < cmnd[t]) t++;
      lag = t;
      break;
    }
  }
  if (lag < 0) return null;
  const [a, b, c] = [cmnd[lag - 1], cmnd[lag], cmnd[lag + 1]];
  const shift = (a - c) / (2 * (a - 2 * b + c)) || 0; // 포물선 보간
  return rate / (lag + shift);
}

export const midiHz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
export const centsOff = (hz: number, midi: number) => 1200 * Math.log2(hz / midiHz(midi));

// 소리 시작 0.1초 뒤부터 0.3초 구간으로 음높이를 잰다 (예상 음 ±1반음 안에서)
export function measureCents(clip: Float64Array, rate: number, midi: number): number {
  const seg = clip.subarray(Math.round(0.1 * rate), Math.round(0.4 * rate));
  const hz = yinHz(seg, rate, midiHz(midi - 1), midiHz(midi + 1));
  if (hz === null) throw new Error(`MIDI ${midi}: 음높이를 잴 수 없어요`);
  return centsOff(hz, midi);
}

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const fileNoteName = (midi: number) => `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
