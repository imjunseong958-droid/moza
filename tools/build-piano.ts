// 아이오와 대학 MIS 스타인웨이 Model B 녹음(AIFF)을 훈련용 피아노 소리로 다듬는다.
//
//   node tools/build-piano.ts <AIFF 폴더>
//
// 폴더에는 Piano.mf.C4.aiff … Piano.mf.B6.aiff (C4–B6, 36개)가 있어야 한다.
// 출처: https://theremin.music.uiowa.edu/MISpiano.html
//
// 하는 일: 스테레오 → 모노, 소리 시작점부터 0.8초, 끝 0.1초 페이드아웃,
// 음마다 처음 0.3초 크기를 같게 맞춤(음량이 단서가 되지 않게), 음높이 점검, 16비트 WAV로 저장.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { NOTE_SEC, attackIndex, fade, fileNoteName, levelAll, measureCents, parseAiff, wav16 } from './audio-files.ts';

const OUT_DIR = resolve(import.meta.dirname, '..', 'web', 'sounds', 'piano');

async function main(): Promise<void> {
  const srcDir = process.argv[2];
  if (!srcDir) {
    console.error('사용법: node tools/build-piano.ts <AIFF 폴더>');
    process.exit(2);
  }
  const notes: { midi: number; clip: Float64Array; rate: number }[] = [];
  for (let midi = 60; midi <= 95; midi++) {
    const name = fileNoteName(midi);
    const { rate, samples } = parseAiff(await readFile(join(srcDir, `Piano.mf.${name}.aiff`)));
    const len = Math.round(NOTE_SEC * rate);
    const start = attackIndex(samples, rate);
    if (start + len > samples.length) throw new Error(`${name}: 소리 시작 뒤 길이가 0.8초보다 짧아요`);
    const clip = samples.slice(start, start + len);
    fade(clip, rate);
    const cents = measureCents(clip, rate, midi);
    notes.push({ midi, clip, rate });
    console.log(`${name.padEnd(4)} 시작 ${(start / rate).toFixed(2)}초  음높이 ${cents >= 0 ? '+' : ''}${cents.toFixed(1)}센트`);
  }
  levelAll(notes.map((n) => n.clip), notes[0].rate);
  await mkdir(OUT_DIR, { recursive: true });
  for (const n of notes) await writeFile(join(OUT_DIR, `${n.midi}.wav`), wav16(n.clip, n.rate));
  console.log(`\n${notes.length}개 저장: ${OUT_DIR}`);
}

await main();
