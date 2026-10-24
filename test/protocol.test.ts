import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as P from '../web/src/protocol.ts';
import * as T from '../web/src/time.ts';

test('음은 F에서 시작해 아래·위로 번갈아 추가된다', () => {
  assert.deepEqual(P.PITCH_ORDER.map((pc) => P.PC_NAMES[pc]), ['F', 'E', 'F#', 'D#', 'G', 'D', 'G#', 'C#', 'A', 'C', 'A#', 'B']);
});

test('범위 밖 음은 세트 양 끝의 ±1·±2 반음이다', () => {
  const names = (n: number) => P.outOfBound(n).map((pc) => P.PC_NAMES[pc]).sort();
  assert.deepEqual(names(1), ['D#', 'E', 'F#', 'G']);
  assert.deepEqual(names(3), ['D', 'D#', 'G', 'G#']);
  assert.deepEqual(names(11), ['B']);
  assert.deepEqual(names(12), []);
});

test('각 세트의 마지막 레벨은 논문 보충자료의 제한 시간과 90% 기준을 쓴다', () => {
  for (let n = 1; n <= 12; n++) {
    const s = P.levelSpec(n, 24);
    assert.equal(s.rtWindow, P.FINAL_RT[n - 1]);
    assert.equal(s.criterion, 0.9);
    assert.equal(s.feedback, false);
  }
  assert.equal(P.levelSpec(12, 24).global, P.TOTAL_LEVELS);
  assert.equal(P.levelSpec(1, 1).criterion, 0.2);
  assert.equal(P.levelSpec(1, 1).feedback, true);
});

test('레벨 문제는 세트의 모든 음을 담고, 범위 밖 음의 정답은 OUT이다', () => {
  for (let n = 1; n <= 12; n++) {
    const count = P.levelSpec(n, 1).trials;
    const trials = P.makeLevelTrials(n, count);
    const set = new Set(P.pitchSet(n));
    assert.equal(trials.length, count);
    for (const t of trials) {
      assert.ok(t.midi >= 60 && t.midi <= 95, `C4–B6 밖: ${t.midi}`);
      assert.equal(P.pcOf(t.midi), t.pc);
      assert.equal(t.answer, set.has(t.pc) ? t.pc : P.OUT);
    }
    for (const pc of set) assert.ok(trials.some((t) => t.pc === pc), `n=${n}에서 ${P.PC_NAMES[pc]} 빠짐`);
  }
});

test('테스트 블록은 72문제이고 연속된 두 음이 항상 12반음보다 멀다', () => {
  for (let k = 0; k < 200; k++) {
    const block = P.makeTestBlock();
    assert.equal(block.length, 72);
    const counts = new Map<number, number>();
    for (const t of block) counts.set(t.midi, (counts.get(t.midi) ?? 0) + 1);
    assert.equal(counts.size, 36);
    assert.ok([...counts.values()].every((c) => c === 2));
    for (let i = 1; i < block.length; i++) assert.ok(Math.abs(block[i].midi - block[i - 1].midi) > 12);
  }
});

test('건너뛰기는 더 높은 레벨의 정확도·제한 시간으로 다시 채점한다', () => {
  const same = (rt: number, correct: number) =>
    Array.from({ length: 12 }, (_, i) => ({ answer: 5, response: i < correct ? 5 : 4, rt }));
  const spec = P.levelSpec(1, 1);
  assert.equal(P.jumpTarget(same(500, 12), spec), 23);   // 24번째 레벨은 건너뛸 수 없다
  assert.equal(P.jumpTarget(same(3000, 12), spec), 10);  // 느리면 제한 시간에서 막힌다
  assert.equal(P.jumpTarget(same(800, 6), spec), 8);     // 50%면 50% 기준 레벨까지
  assert.equal(P.jumpTarget(same(800, 3), spec), null);
});

test('테스트 채점: 무응답은 오차 3반음, 반음 오차는 원 위 거리', () => {
  assert.equal(P.semitoneError(0, 11), 1);
  assert.equal(P.semitoneError(0, 6), 6);
  const results = P.makeTestBlock().map((t, i) => ({
    ...t,
    timbre: 'piano' as const,
    response: i % 2 ? t.pc : null,
    rt: i % 2 ? 1500 : null,
    correct: i % 2 === 1,
  }));
  const score = P.scoreTest(results);
  assert.equal(score.piano.correct, 0.5);
  assert.equal(score.piano.error, 1.5);
  assert.equal(score.piano.rt, 1500);
  assert.equal(score.guitar.n, 0);
});

test('15분 미만 세션은 인정하지 않고, 3분 넘게 쉬면 새 세션이 된다', () => {
  const state: T.TimeState = { startDate: null, session: null, sessions: [] };
  const base = new Date('2026-10-24T09:00:00').getTime();
  const min = 60_000;
  for (let m = 0; m <= 14; m++) T.markActivity(state, base + m * min);
  T.markActivity(state, base + 30 * min);
  for (let m = 31; m <= 47; m++) T.markActivity(state, base + m * min);
  T.endSession(state);
  assert.deepEqual(state.sessions.map((s) => [s.active / min, s.counted]), [[14, false], [17, true]]);
  assert.equal(T.totalMs(state), 17 * min);
  assert.equal(T.dayMs(state, '2026-10-24'), 17 * min);
});

test('주차는 첫 훈련일부터 센다', () => {
  const state: T.TimeState = { startDate: '2026-10-24', session: null, sessions: [] };
  assert.equal(T.programWeek(state, new Date('2026-10-30T23:00:00').getTime()), 1);
  assert.equal(T.programWeek(state, new Date('2026-10-31T01:00:00').getTime()), 2);
  assert.equal(T.programWeek(state, new Date('2026-12-18T12:00:00').getTime()), 8);
  assert.equal(T.programWeek(state, new Date('2026-12-19T12:00:00').getTime()), 9);
});
