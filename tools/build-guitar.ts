// 아이오와 대학 MIS 기타 녹음(Raimundo 118 클래식 기타, 무반향실)을 테스트용 기타 소리로 다듬는다.
//
//   node tools/build-guitar.ts <AIF 폴더>
//
// 폴더에 있어야 하는 파일 (mf, 모노, 24비트 96kHz):
//   Guitar.mf.sulB.C4B4.mono.aif   → C4–D#4 (2번 줄)
//   Guitar.mf.sul_E.E4B4.mono.aif  → E4–B4 (1번 줄)
//   Guitar.mf.sul_E.C5B5.mono.aif  → C5–B5 (1번 줄), C6–B6 (한 옥타브 올림)
// 출처: https://theremin.music.uiowa.edu/MISguitar.html
//
// 한 파일에 한 줄의 반음계가 차례로 녹음돼 있어서, 소리가 갑자기 커지는 지점으로 음을 나누고
// 조각마다 음높이를 재서 어느 음인지 확인한다. 클래식 기타는 B5가 가장 높은 음이라
// C6–B6은 5옥타브 녹음을 2배 속도로 리샘플해 만든다 (음높이는 정확히 한 옥타브 위).
// 녹음된 기타는 평균율보다 8–26센트 낮게 조율돼 있어서, 음마다 A4 = 440Hz 평균율에 맞춘다.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  NOTE_SEC, OUT_RATE, attackIndex, centsOff, fade, fileNoteName, levelAll, measureCents, midiHz,
  parseAiff, resample, wav16, yinHz, type Audio,
} from './audio-files.ts';

const OUT_DIR = resolve(import.meta.dirname, '..', 'web', 'sounds', 'guitar');
const FRAME_SEC = 0.01;
const LOOKBACK_FRAMES = 30;   // 직전 0.3초의 가장 작은 크기보다
const JUMP = 3;               // 3배 넘게 커지면 새 음의 시작으로 본다
const MIN_LEVEL = 0.05;       // 파일 최댓값의 5% 아래는 무시
const MIN_GAP_SEC = 1;

const SOURCES = [
  { file: 'Guitar.mf.sulB.C4B4.mono.aif', low: 60, high: 71, use: [60, 63] },
  { file: 'Guitar.mf.sul_E.E4B4.mono.aif', low: 64, high: 71, use: [64, 71] },
  { file: 'Guitar.mf.sul_E.C5B5.mono.aif', low: 72, high: 83, use: [72, 83] },
] as const;

// 파일 안의 음 시작점을 찾고, 음높이로 어느 음인지 붙인다 (같은 음이 또 나오면 처음 것)
function findNotes(audio: Audio, low: number, high: number): Map<number, { onset: number; hz: number }> {
  const { rate, samples } = audio;
  const hop = Math.round(FRAME_SEC * rate);
  const env: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += samples[j] * samples[j];
    env.push(Math.sqrt(s / hop));
  }
  const peak = Math.max(...env);
  const notes = new Map<number, { onset: number; hz: number }>();
  let last = -Infinity;
  for (let f = LOOKBACK_FRAMES; f < env.length; f++) {
    if ((f - last) * FRAME_SEC < MIN_GAP_SEC) continue;
    const before = Math.min(...env.slice(f - LOOKBACK_FRAMES, f));
    if (env[f] < MIN_LEVEL * peak || env[f] < JUMP * before) continue;
    last = f;
    const onset = attackIndex(samples, rate, (f - 2) * hop, 0.1);
    // 탄현 직후에는 2배음이 강해 한 옥타브 위로 잡히기 쉬워서, 조금 뒤 구간을 파일 음역 안에서만 잰다
    const seg = samples.subarray(onset + Math.round(0.15 * rate), onset + Math.round(0.4 * rate));
    const hz = yinHz(seg, rate, midiHz(low - 0.5), midiHz(high + 0.5));
    if (hz === null) continue;
    const midi = Math.round(69 + 12 * Math.log2(hz / 440));
    if (midi >= low && midi <= high && Math.abs(centsOff(hz, midi)) < 50 && !notes.has(midi)) notes.set(midi, { onset, hz });
  }
  return notes;
}

async function main(): Promise<void> {
  const srcDir = process.argv[2];
  if (!srcDir) {
    console.error('사용법: node tools/build-guitar.ts <AIF 폴더>');
    process.exit(2);
  }
  const len = Math.round(NOTE_SEC * OUT_RATE);
  const clips = new Map<number, Float64Array>();
  for (const src of SOURCES) {
    const audio = parseAiff(await readFile(join(srcDir, src.file)));
    const found = findNotes(audio, src.low, src.high);
    const [from, to] = src.use;
    const missing = Array.from({ length: to - from + 1 }, (_, k) => from + k).filter((m) => !found.has(m));
    if (missing.length) throw new Error(`${src.file}: ${missing.map(fileNoteName).join(', ')} 를 찾지 못했어요`);
    for (let midi = from; midi <= to; midi++) {
      const { onset, hz } = found.get(midi)!;
      const cents = centsOff(hz, midi);
      const tune = 2 ** (-cents / 1200); // 평균율로 맞추는 재생 속도
      clips.set(midi, resample(audio, OUT_RATE, onset, len, tune));
      if (midi >= 72) clips.set(midi + 12, resample(audio, OUT_RATE, onset, len, 2 * tune)); // 한 옥타브 위
      console.log(`${fileNoteName(midi).padEnd(4)} ${src.file}  ${(onset / audio.rate).toFixed(2)}초  원래 ${cents >= 0 ? '+' : ''}${cents.toFixed(1)}센트`);
    }
  }
  const midis = [...clips.keys()].sort((a, b) => a - b);
  for (const midi of midis) fade(clips.get(midi)!, OUT_RATE);
  levelAll(midis.map((m) => clips.get(m)!), OUT_RATE);
  await mkdir(OUT_DIR, { recursive: true });
  let worst = 0;
  const report: string[] = [];
  for (const midi of midis) {
    const clip = clips.get(midi)!;
    const cents = measureCents(clip, OUT_RATE, midi);
    worst = Math.max(worst, Math.abs(cents));
    report.push(`${fileNoteName(midi)} ${cents >= 0 ? '+' : ''}${cents.toFixed(0)}`);
    await writeFile(join(OUT_DIR, `${midi}.wav`), wav16(clip, OUT_RATE));
  }
  console.log(`\n음높이(센트): ${report.join('  ')}`);
  console.log(`${midis.length}개 저장: ${OUT_DIR}  (음높이 최대 차이 ${worst.toFixed(1)}센트)`);
}

await main();
