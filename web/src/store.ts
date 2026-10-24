// 기록 저장: 로컬 서버(/api/state)를 거쳐 ~/.moza/state.json 에 쓴다

import type { TestScore } from './protocol.ts';
import type { TimeState } from './time.ts';

export type LevelMode = 'level' | 'oneTake' | 'free';
export type TestKind = 'pre' | 'mid' | 'post';

export interface Progress {
  n: number;                // 학습 중인 음 개수
  level: number;            // 1–24
  failStreak: number;
  levelsSinceFocus: number;
  finalStreak: number;      // 레벨 288 연속 통과 횟수
  oneTake: boolean;         // 원테이크 도전 대기 중
  lockUntil: number | null; // 원테이크 전 12시간 휴식이 끝나는 시각
  graduated: boolean;
  graduatedAt: number | null;
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
  trainedMs: number;
  level: number;
}

export interface AppState extends TimeState {
  version: 1;
  createdAt: number;
  progress: Progress;
  points: number;
  tokens: number;
  totalTrials: number;
  pitchStats: Record<number, boolean[]>; // 음별 최근 정답 여부
  levelLog: LevelLogEntry[];
  tests: TestEntry[];
}

export function freshState(): AppState {
  return {
    version: 1,
    createdAt: Date.now(),
    startDate: null,
    progress: {
      n: 1,
      level: 1,
      failStreak: 0,
      levelsSinceFocus: 0,
      finalStreak: 0,
      oneTake: false,
      lockUntil: null,
      graduated: false,
      graduatedAt: null,
    },
    points: 0,
    tokens: 0,
    totalTrials: 0,
    session: null,
    sessions: [],
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
