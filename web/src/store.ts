// 기록 저장: 로컬 서버(/api/state)를 거쳐 ~/.moza/state.json 에 쓴다

import type { TestScore } from './protocol.ts';

export type LevelMode = 'level' | 'oneTake';
export type TestKind = 'pre' | 'mid' | 'post';

export interface Progress {
  n: number;                // 학습 중인 음 개수
  level: number;            // 1–24
  failStreak: number;
  levelsSinceFocus: number;
  finalStreak: number;      // 레벨 288 연속 통과 횟수
  oneTake: boolean;         // 원테이크 도전 대기 중
  lockUntil: number | null; // 원테이크 전 12시간 휴식이 끝나는 시각
}

export interface LevelLogEntry {
  t: number;
  n: number;
  level: number;
  acc: number;
  pass: boolean;
  mode: LevelMode;
}

export interface TestEntry extends TestScore {
  t: number;
  kind: TestKind;
  round?: number; // 예전 기록에는 없음 (1회차)
  level: number;
}

export interface AppState {
  version: 1;
  createdAt: number;
  startDate: string | null; // 첫 훈련일 YYYY-MM-DD
  round: number;            // 회차. 졸업하면 기록은 두고 F 1단계부터 다음 회차
  graduations: number[];    // 졸업한 시각
  progress: Progress;
  points: number;
  tokens: number;
  totalTrials: number;
  pitchStats: Record<number, boolean[]>; // 음별 최근 정답 여부
  levelLog: LevelLogEntry[];
  tests: TestEntry[];
}

export function freshProgress(): Progress {
  return {
    n: 1,
    level: 1,
    failStreak: 0,
    levelsSinceFocus: 0,
    finalStreak: 0,
    oneTake: false,
    lockUntil: null,
  };
}

export function freshState(): AppState {
  return {
    version: 1,
    createdAt: Date.now(),
    startDate: null,
    round: 1,
    graduations: [],
    progress: freshProgress(),
    points: 0,
    tokens: 0,
    totalTrials: 0,
    pitchStats: {},
    levelLog: [],
    tests: [],
  };
}

export async function load(): Promise<AppState> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`state ${res.status}`);
  const data = (await res.json()) as Partial<AppState> | null;
  const base = freshState();
  return data ? { ...base, ...data, progress: { ...base.progress, ...data.progress } } : base;
}

let current: AppState | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let onError: (err: unknown) => void = () => {};

export function onSaveError(fn: (err: unknown) => void): void {
  onError = fn;
}

export function save(state: AppState): void {
  current = state;
  dirty = true;
  clearTimeout(timer);
  timer = setTimeout(flush, 600);
}

export async function flush(): Promise<void> {
  clearTimeout(timer);
  if (!dirty) return;
  dirty = false;
  try {
    const res = await fetch('/api/state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(current),
    });
    if (!res.ok) throw new Error(`save ${res.status}`);
    onError(null);
  } catch (err) {
    dirty = true;
    onError(err);
  }
}

export function flushOnExit(): void {
  if (!dirty) return;
  navigator.sendBeacon('/api/state', new Blob([JSON.stringify(current)], { type: 'application/json' }));
}
