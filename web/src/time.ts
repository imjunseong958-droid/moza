// 훈련 시간 계산: 세션, 하루·주·전체 인정 시간, 연속 일수

export const IDLE_MS = 3 * 60 * 1000;            // 3분 동안 입력이 없으면 세션 종료
export const MIN_SESSION_MS = 15 * 60 * 1000;    // 15분 미만 세션은 인정하지 않음 (논문 규칙)
export const DAILY_GOAL_MS = 25 * 60 * 1000;     // 하루 25분
export const WEEKLY_MIN_MS = 2 * 3600 * 1000;    // 주 2시간 이상
export const TOTAL_GOAL_MS = 25 * 3600 * 1000;   // 8주 25시간
export const PROGRAM_WEEKS = 8;
const DAY_MS = 24 * 3600 * 1000;

export interface Session {
  start: number;
  last: number;    // 마지막 입력 시각
  active: number;  // 입력 사이 간격의 합, ms
}

export interface SessionRecord {
  start: number;
  end: number;
  active: number;
  counted: boolean;
}

export interface TimeState {
  startDate: string | null; // 첫 훈련일 YYYY-MM-DD
  session: Session | null;
  sessions: SessionRecord[];
}

export function dayKey(t: number | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dayStart = (key: string): number => new Date(`${key}T00:00:00`).getTime();

// 입력이 있을 때마다 부른다. 3분 넘게 비었으면 이전 세션을 닫고 새 세션을 연다.
export function markActivity(state: TimeState, now = Date.now()): void {
  const s = state.session;
  if (s && now - s.last <= IDLE_MS) {
    s.active += now - s.last;
    s.last = now;
    return;
  }
  endSession(state);
  state.session = { start: now, last: now, active: 0 };
}

export function endSession(state: TimeState): void {
  const s = state.session;
  if (!s) return;
  state.sessions.push({ start: s.start, end: s.last, active: s.active, counted: s.active >= MIN_SESSION_MS });
  state.session = null;
}

export function endIdleSession(state: TimeState, now = Date.now()): boolean {
  if (!state.session || now - state.session.last <= IDLE_MS) return false;
  endSession(state);
  return true;
}

function countedSessions(state: TimeState): { start: number; active: number }[] {
  const list: { start: number; active: number }[] = state.sessions.filter((s) => s.counted);
  if (state.session && state.session.active >= MIN_SESSION_MS) list.push(state.session);
  return list;
}

const sum = (list: { active: number }[]) => list.reduce((s, x) => s + x.active, 0);

// 화면 표시용: 마지막 입력 뒤 흐른 시간까지 포함한 현재 세션 길이
export function sessionMs(state: TimeState, now = Date.now()): number {
  const s = state.session;
  if (!s) return 0;
  const gap = now - s.last;
  return s.active + (gap <= IDLE_MS ? gap : 0);
}

export const totalMs = (state: TimeState): number => sum(countedSessions(state));

export const dayMs = (state: TimeState, key: string): number =>
  sum(countedSessions(state).filter((s) => dayKey(s.start) === key));

export const todayMs = (state: TimeState): number => dayMs(state, dayKey(Date.now()));

export function dailyTotals(state: TimeState): Map<string, number> {
  const totals = new Map<string, number>();
  for (const s of countedSessions(state)) {
    const k = dayKey(s.start);
    totals.set(k, (totals.get(k) ?? 0) + s.active);
  }
  return totals;
}

// 첫 훈련일부터 1주차
export function programWeek(state: TimeState, now = Date.now()): number {
  if (!state.startDate) return 0;
  const days = Math.round((dayStart(dayKey(now)) - dayStart(state.startDate)) / DAY_MS);
  return Math.floor(days / 7) + 1;
}

export const weekMs = (state: TimeState, week: number): number =>
  sum(countedSessions(state).filter((s) => programWeek(state, s.start) === week));

// 인정된 세션이 있는 날이 오늘(또는 어제)까지 며칠 연속인지
export function streakDays(state: TimeState, now = Date.now()): number {
  const days = new Set(countedSessions(state).map((s) => dayKey(s.start)));
  const d = new Date(now);
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (days.has(dayKey(d))) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
