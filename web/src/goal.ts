// 하루 목표 계산: 날짜별 레벨 도전 횟수, 연속 일수
// 시간은 재지 않는다. 레벨을 끝까지 풀 때마다(통과든 실패든) 1번으로 센다.

export const DAILY_GOAL = 24; // 하루 레벨 24번 도전

interface Attempt {
  t: number;
}

export function dayKey(t: number | Date): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dailyCounts(log: Attempt[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of log) {
    const k = dayKey(a.t);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export const dayCount = (log: Attempt[], key: string): number => log.filter((a) => dayKey(a.t) === key).length;

export const todayCount = (log: Attempt[], now = Date.now()): number => dayCount(log, dayKey(now));

// 하루 목표를 채운 날이 오늘(또는 어제)까지 며칠 연속인지
export function streakDays(log: Attempt[], now = Date.now()): number {
  const counts = dailyCounts(log);
  const met = (d: Date) => (counts.get(dayKey(d)) ?? 0) >= DAILY_GOAL;
  const d = new Date(now);
  if (!met(d)) d.setDate(d.getDate() - 1);
  let n = 0;
  while (met(d)) {
    n += 1;
    d.setDate(d.getDate() - 1);
  }
  return n;
}
