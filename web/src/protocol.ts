// 훈련 프로토콜
// 근거: Wong, Cheung, Ngan & Wong (2025). Learning fast and accurate absolute pitch
// judgment in adulthood. Psychonomic Bulletin & Review. doi:10.3758/s13423-024-02620-2
// 논문에 수치가 있는 부분은 그대로 쓰고, 레벨별 통과 기준·문제 수처럼 논문에 없는 부분은
// README의 "재구성한 부분"에 적은 대로 채웠다.

/** 음 종류: 0 = C … 11 = B */
export type PitchClass = number;
/** 정답·응답: 음 종류 또는 OUT(범위 밖) */
export type Answer = number;
export type Timbre = 'piano' | 'guitar';

export interface Trial {
  midi: number;
  pc: PitchClass;
  answer: Answer;
}

export interface TrialResult extends Trial {
  response: Answer | null; // null = 시간 초과
  rt: number | null;       // 소리가 나온 순간부터 ms
  correct: boolean;
}

export type Response = Pick<TrialResult, 'answer' | 'response' | 'rt'>;

export interface LevelSpec {
  n: number;          // 학습 중인 음 개수
  level: number;      // 1–24
  stage: number;      // 1–12
  global: number;     // 1–288
  criterion: number;  // 통과 정확도
  rtWindow: number;   // 반응 시간 제한, ms
  feedback: boolean;
  trials: number;
  isFinal: boolean;   // 24번째 레벨: 통과하면 새 음 추가
}

export interface TimbreScore {
  n: number;
  correct: number;     // 정답률
  error: number;       // 평균 오차(반음)
  rt: number | null;   // 정답 반응 시간 평균, ms
  byPc: number[];      // 음별 정답률
}

export type TestScore = Record<Timbre, TimbreScore>;

export const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SOLFEGE = ['도', '도#', '레', '레#', '미', '파', '파#', '솔', '솔#', '라', '라#', '시'];
export const ALL_PCS: PitchClass[] = PC_NAMES.map((_, pc) => pc);
export const OUT: Answer = -1;

// F에서 시작해 아래·위로 번갈아 이웃 음을 하나씩 추가한다 (E, F#, D#, G, ...)
export const PITCH_ORDER: PitchClass[] = [5, 4, 6, 3, 7, 2, 8, 1, 9, 0, 10, 11];
export const LEVELS_PER_SET = 24;
export const TOTAL_LEVELS = PITCH_ORDER.length * LEVELS_PER_SET;

// 보충자료 Table 1: 음 n개 세트의 마지막(24번째) 레벨 반응 시간 제한, ms
export const FINAL_RT = [1183, 1242, 1305, 1371, 1440, 1513, 1589, 1668, 1751, 1839, 1930, 2028];
export const TEST_RT = 5000;

// 24레벨 = 12단계 × (정답 알려주는 레벨, 안 알려주는 레벨)
const STAGE_CRITERION = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.9, 0.9, 0.9, 0.9];
const STAGE_RT_SCALE = [4, 4, 3.5, 3, 2.6, 2.3, 2, 1.8, 1.6, 1.4, 1.2, 1];

export const OCTAVES = [4, 5, 6]; // C4–B6
const TRAIN_MIN_GAP = 7;          // 훈련: 연속된 두 음은 7반음 이상 떨어뜨림
const TEST_MIN_GAP = 13;          // 테스트: 연속된 두 음은 12반음보다 멀리 (논문)

export const midiOf = (pc: PitchClass, octave: number): number => 12 * (octave + 1) + pc;
export const pcOf = (midi: number): PitchClass => ((midi % 12) + 12) % 12;
export const pitchSet = (n: number): PitchClass[] => PITCH_ORDER.slice(0, n);

export function levelSpec(n: number, level: number): LevelSpec {
  const stage = Math.ceil(level / 2);
  return {
    n,
    level,
    stage,
    global: (n - 1) * LEVELS_PER_SET + level,
    criterion: STAGE_CRITERION[stage - 1],
    rtWindow: Math.min(TEST_RT, Math.round(FINAL_RT[n - 1] * STAGE_RT_SCALE[stage - 1])),
    feedback: level % 2 === 1,
    trials: Math.max(12, 6 + 2 * n),
    isFinal: level === LEVELS_PER_SET,
  };
}

// 세트 양 끝 바깥의 +1·+2, −1·−2 반음 (세트는 F를 중심으로 이어진 구간)
export function outOfBound(n: number): PitchClass[] {
  if (n >= PITCH_ORDER.length) return [];
  const low = -Math.floor(n / 2);
  const high = Math.floor((n - 1) / 2);
  const set = new Set(pitchSet(n));
  const pcs = [high + 1, high + 2, low - 1, low - 2].map((r) => pcOf(5 + r)).filter((pc) => !set.has(pc));
  return [...new Set(pcs)];
}

// 범위 밖 음의 비중: 음 1개일 때는 다른 음과 같고, 세트가 커질수록 줄어든다
const outOfBoundWeight = (n: number): number => (12 - n) / 11;

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// count개를 가중치대로 나눈다 (최대 나머지 방식, 동점은 무작위)
function allocate<T extends { w: number }>(items: T[], count: number) {
  const sum = items.reduce((s, it) => s + it.w, 0);
  const rows = items.map((it) => {
    const exact = (count * it.w) / sum;
    return { ...it, exact, count: Math.floor(exact) };
  });
  const left = count - rows.reduce((s, r) => s + r.count, 0);
  shuffle([...rows])
    .sort((a, b) => (b.exact - b.count) - (a.exact - a.count))
    .slice(0, left)
    .forEach((r) => { r.count += 1; });
  return rows;
}

// 음마다 무작위 옥타브를 고르되, 직전 음과 minGap 반음 이상 떨어지게 한다
function placeOctaves(pcs: PitchClass[], minGap: number): number[] {
  let prev: number | null = null;
  return pcs.map((pc) => {
    const options = OCTAVES.map((o) => midiOf(pc, o));
    const far = prev === null ? options : options.filter((m) => Math.abs(m - prev!) >= minGap);
    prev = pick(far.length ? far : options);
    return prev;
  });
}

export function makeLevelTrials(n: number, count: number): Trial[] {
  const items = [
    ...pitchSet(n).map((pc) => ({ pc, answer: pc, w: 1 })),
    ...outOfBound(n).map((pc) => ({ pc, answer: OUT, w: outOfBoundWeight(n) })),
  ];
  const pool = shuffle(allocate(items, count).flatMap((r) => Array.from({ length: r.count }, () => r)));
  const midis = placeOctaves(pool.map((r) => r.pc), TRAIN_MIN_GAP);
  return pool.map((r, i) => ({ midi: midis[i], pc: r.pc, answer: r.answer }));
}

// 약점 집중 연습: 절반은 약한 음, 나머지는 세트의 다른 음
export function makeFocusTrials(set: PitchClass[], weak: PitchClass, count: number): Trial[] {
  const others = set.filter((pc) => pc !== weak);
  const half = Math.ceil(count / 2);
  const pcs = shuffle([
    ...Array<PitchClass>(half).fill(weak),
    ...Array.from({ length: count - half }, () => pick(others)),
  ]);
  const midis = placeOctaves(pcs, TRAIN_MIN_GAP);
  return pcs.map((pc, i) => ({ midi: midis[i], pc, answer: pc }));
}

// 테스트 한 블록: 12음 × 3옥타브 × 2번 = 72문제
export function makeTestBlock(): Trial[] {
  const items: number[] = [];
  for (const pc of ALL_PCS) for (const o of OCTAVES) items.push(midiOf(pc, o), midiOf(pc, o));
  for (let attempt = 0; attempt < 1000; attempt++) {
    const order = orderFarApart(items, TEST_MIN_GAP);
    if (order) return order.map((midi) => ({ midi, pc: pcOf(midi), answer: pcOf(midi) }));
  }
  throw new Error('테스트 순서를 만들지 못했어요');
}

// 이을 수 있는 음이 가장 적은 음부터 고른다 (Warnsdorff 규칙). 가운데 옥타브 음은
// 이을 수 있는 음이 적어서, 아무렇게나 고르면 끝에서 막힌다.
function orderFarApart(items: number[], gap: number): number[] | null {
  const left = shuffle([...items]);
  const out: number[] = [];
  const far = (a: number, b: number) => Math.abs(a - b) >= gap;
  let prev: number | null = null;
  while (left.length) {
    const ok = left.flatMap((m, i) => (prev === null || far(m, prev) ? [i] : []));
    if (!ok.length) return null;
    const degree = ok.map((i) => left.filter((m, j) => j !== i && far(m, left[i])).length);
    const fewest = Math.min(...degree);
    const k = pick(ok.filter((_, x) => degree[x] === fewest));
    prev = left[k];
    out.push(prev);
    left.splice(k, 1);
  }
  return out;
}

// ---------- 채점 ----------

export function semitoneError(a: PitchClass, b: PitchClass): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

export const isHit = (r: Response, rtWindow: number): boolean =>
  r.response === r.answer && r.rt !== null && r.rt <= rtWindow;

export const accuracy = (results: Response[], rtWindow: number): number =>
  results.filter((r) => isHit(r, rtWindow)).length / results.length;

export const passes = (acc: number, criterion: number): boolean => acc + 1e-9 >= criterion;

// 이번 레벨 응답을 더 높은 레벨 기준(정확도·제한 시간)으로 다시 채점해서 건너뛸 수 있는 가장 높은 레벨.
// 각 세트의 24번째 레벨은 건너뛸 수 없다.
export function jumpTarget(results: Response[], spec: LevelSpec): number | null {
  let best: number | null = null;
  for (let level = spec.level + 2; level < LEVELS_PER_SET; level++) {
    const s = levelSpec(spec.n, level);
    if (!passes(accuracy(results, s.rtWindow), s.criterion)) break;
    best = level;
  }
  return best;
}

export const tokensFor = (acc: number): number => (acc >= 0.9 ? 3 : acc >= 0.75 ? 2 : acc >= 0.6 ? 1 : 0);

// 최근 정답률이 가장 낮은 음 (기록이 적은 음은 50%로 본다)
export function weakestPitch(set: PitchClass[], stats: Record<number, boolean[]>): PitchClass {
  const score = (pc: PitchClass) => {
    const h = stats[pc] ?? [];
    return h.length < 3 ? 0.5 : h.filter(Boolean).length / h.length;
  };
  const min = Math.min(...set.map(score));
  return pick(set.filter((pc) => score(pc) === min));
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

// 정답률, 평균 오차(반음, 무응답은 우연 수준인 3), 정답 반응 시간
function scoreTimbre(rs: TrialResult[]): TimbreScore {
  const hits = rs.filter((r) => isHit(r, TEST_RT));
  return {
    n: rs.length,
    correct: rs.length ? hits.length / rs.length : 0,
    error: rs.length ? mean(rs.map((r) => (r.response === null ? 3 : semitoneError(r.response, r.pc)))) : 3,
    rt: hits.length ? Math.round(mean(hits.map((r) => r.rt!))) : null,
    byPc: ALL_PCS.map((pc) => {
      const xs = rs.filter((r) => r.pc === pc);
      return xs.length ? xs.filter((r) => isHit(r, TEST_RT)).length / xs.length : 0;
    }),
  };
}

export function scoreTest(results: (TrialResult & { timbre: Timbre })[]): TestScore {
  return {
    piano: scoreTimbre(results.filter((r) => r.timbre === 'piano')),
    guitar: scoreTimbre(results.filter((r) => r.timbre === 'guitar')),
  };
}
