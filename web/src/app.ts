// MOZA — 성인 절대음감 훈련 앱
// 훈련 규칙은 protocol.ts, 소리는 audio.ts, 시간 계산은 time.ts, 저장은 store.ts에 있다.
import * as P from './protocol.ts';
import * as A from './audio.ts';
import * as T from './time.ts';
import * as S from './store.ts';
import type { Answer, LevelSpec, PitchClass, Timbre, Trial, TrialResult } from './protocol.ts';
import type { AppState, LevelMode, TestEntry, TestKind } from './store.ts';

declare global {
  interface Window {
    moza?: unknown;
  }
}

type Actions = Record<string, (data: DOMStringMap) => void>;
type KeyHandler = (e: KeyboardEvent) => void;

interface RunConfig {
  name: string;
  title: string;
  trials: Trial[];
  rtWindow: number;
  feedback: boolean;
  timbre: Timbre;
  activePcs: readonly PitchClass[];
  allowOut: boolean;
  doubles: Set<number>; // 점수 2배 문제 번호
  training: boolean;    // 훈련 시간에 들어가는지
  onDone: (results: TrialResult[]) => void;
  onQuit: () => void;
}

interface LevelOutcome {
  acc: number;
  pass: boolean;
  points: number;
  tokens: number;
  failStreak: number;
  focusNext: boolean;
  jump?: number | null;
  newPc?: PitchClass;
  finalStreak?: number;
  lockStarted?: boolean;
  graduated?: boolean;
  oneTakeFailed?: boolean;
}

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const SHEPARD_SEC = DEBUG && params.has('fast') ? 1 : 20;

const KEY_CODES = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ'];
const RANDOM_DOUBLE = 1 / 80;               // 약 80문제에 한 번 점수 2배
const TOKENS_PER_DOUBLE = 10;               // 토큰 10개 = 2배 찬스 한 번
const FINAL_STREAK = 3;                     // 마지막 레벨 3연속 통과 →
const ONE_TAKE_REST_MS = 12 * 3600 * 1000;  // 12시간 쉬고 원테이크
const FOCUS_EVERY = 15;                     // 음 5개부터 15레벨마다 약점 집중 연습
const FOCUS_MIN_PITCHES = 5;
const FAILS_BEFORE_EASIER = 10;             // 10번 연속 실패하면 쉬운 레벨로 돌아갈 수 있다
const TEST_LABEL: Record<TestKind, string> = { pre: '사전 테스트', mid: '중간 점검', post: '사후 테스트' };
const LOG_LIMIT = 5000;
const STATS_LIMIT = 40;

const app = document.getElementById('app')!;
let state!: AppState;
let screen = '';
let actions: Actions = {};
let keyHandler: KeyHandler | null = null;
let stopCurrent: (() => void) | null = null; // 진행 중인 문제 루프나 카운트다운을 멈춘다
let debugTrial: Trial | null = null;

// ---------- 공통 ----------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${parseFloat((ms / 1000).toFixed(2))}초`;
const minutes = (ms: number) => `${Math.floor(ms / 60000)}분`;
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const hoursMinutes = (ms: number) => {
  const m = Math.floor(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
};
const shortDate = (t: number) => {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};
const noteName = (pc: Answer) => (pc === P.OUT ? '범위 밖' : P.PC_NAMES[pc]);
const noteLabel = (pc: Answer) => (pc === P.OUT ? '범위 밖' : `${P.PC_NAMES[pc]} (${P.SOLFEGE[pc]})`);
const byPitch = (a: number, b: number) => a - b;
const onEnter = (fn: () => void): KeyHandler => (e) => {
  if (e.code === 'Enter' || e.code === 'NumpadEnter') {
    e.preventDefault();
    fn();
  }
};
const lockedNow = (now = Date.now()) => {
  const p = state.progress;
  return !p.graduated && p.oneTake && now < (p.lockUntil ?? 0);
};

function render(name: string, html: string, acts: Actions = {}, onKey: KeyHandler | null = null): void {
  if (stopCurrent) {
    const stop = stopCurrent;
    stopCurrent = null;
    stop();
  }
  screen = name;
  actions = acts;
  keyHandler = onKey;
  app.innerHTML = html;
  window.scrollTo(0, 0);
  updateClocks();
}

app.addEventListener('mousedown', (e) => {
  // 건반이 포커스를 가져가면 Space에 다시 눌리므로 막는다
  if ((e.target as Element).closest('.key, .out-key')) e.preventDefault();
});
app.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  A.unlock();
  actions[el.dataset.act!]?.(el.dataset);
});
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
  A.unlock();
  keyHandler?.(e);
});

function touch(): void {
  T.markActivity(state);
  S.save(state);
  updateClocks();
}

function clockText(): string {
  const sess = T.sessionMs(state);
  const text = `오늘 ${minutes(T.todayMs(state))} / 25분`;
  return sess > 0 && sess < T.MIN_SESSION_MS ? `${text} · 세션 ${clock(sess)} (15분부터 인정)` : text;
}

function updateClocks(): void {
  for (const el of app.querySelectorAll('[data-clock]')) el.textContent = clockText();
}

function tick(): void {
  if (T.endIdleSession(state)) {
    S.save(state);
    if (screen === 'train' || screen === 'shepard') {
      showHome('3분 동안 입력이 없어서 세션을 끝냈어요. 하던 레벨은 기록되지 않았어요.');
      return;
    }
  }
  updateClocks();
}

// ---------- 홈 ----------

function ringSVG(countedMs: number, pendingMs: number): string {
  const r = 52;
  const c = 2 * Math.PI * r;
  const done = Math.min(1, countedMs / T.DAILY_GOAL_MS);
  const pending = Math.min(1 - done, pendingMs / T.DAILY_GOAL_MS);
  const arc = (frac: number, cls: string) =>
    frac > 0 ? `<circle cx="60" cy="60" r="${r}" class="${cls}" stroke-dasharray="${frac * c} ${c}" transform="rotate(-90 60 60)"/>` : '';
  return `
    <svg viewBox="0 0 120 120" class="ring" aria-label="오늘 ${minutes(countedMs)} / 25분">
      <circle cx="60" cy="60" r="${r}" class="track"/>
      ${arc(done + pending, 'pending')}
      ${arc(done, 'done')}
      <text x="60" y="62" class="ring-num">${Math.floor(countedMs / 60000)}</text>
      <text x="60" y="82" class="ring-sub">/ 25분</text>
    </svg>`;
}

function chromaSVG(n: number): string {
  const set = new Set(P.pitchSet(n));
  const next = n < 12 ? P.PITCH_ORDER[n] : null;
  const nodes = P.ALL_PCS.map((pc) => {
    const a = ((pc * 30 - 90) * Math.PI) / 180;
    const x = (100 + 76 * Math.cos(a)).toFixed(1);
    const y = (100 + 76 * Math.sin(a)).toFixed(1);
    const cls = set.has(pc) ? 'on' : pc === next ? 'next' : '';
    return `<g class="pc ${cls}"><circle cx="${x}" cy="${y}" r="17"/><text x="${x}" y="${y}">${P.PC_NAMES[pc]}</text></g>`;
  }).join('');
  return `
    <svg viewBox="0 0 200 200" class="chroma" aria-label="학습한 음 ${n}개">
      ${nodes}
      <text x="100" y="98" class="mid">${n}</text>
      <text x="100" y="120" class="mid-sub">/ 12음</text>
    </svg>`;
}

function aboutHTML(): string {
  return `
    <details class="card about">
      <summary>이 앱은 어떻게 훈련하나요?</summary>
      <ul>
        <li>F 한 음에서 시작해 옆 음을 아래·위 번갈아 하나씩 늘려 12음까지 가요. 음마다 24단계, 모두 288레벨이에요.</li>
        <li>단계가 오를수록 통과 기준이 20%에서 90%로 오르고 제한 시간이 줄어요. 마지막 단계는 음 1개일 때 1.18초, 12개일 때 2.03초예요.</li>
        <li>정답을 알려주는 레벨 다음에 알려주지 않는 레벨이 와요. 그 전에는 20초 셰퍼드 톤으로 방금 들은 음의 기억을 지워요.</li>
        <li>학습 중인 음 바로 바깥의 음도 섞여 나와요. 그럴 땐 "범위 밖"을 눌러요.</li>
        <li>피아노 3옥타브(C4–B6)에서 무작위로 나와요. 높이가 아니라 음 이름(음 종류)을 익히는 훈련이에요.</li>
        <li>음 5개부터는 15레벨마다 가장 약한 음을 집중 연습해요.</li>
        <li>마지막 레벨을 3번 연속 통과하고, 12시간 쉰 뒤 한 번에 다시 통과하면 졸업이에요.</li>
      </ul>
      <p class="muted">근거: Wong, Cheung, Ngan &amp; Wong (2025), Psychonomic Bulletin &amp; Review. 음악인 12명이 8주 동안 평균 21시간 훈련해서 평균 7개 음을 익혔고, 2명은 12음 전부를 익혔어요.</p>
    </details>`;
}

function showHome(notice = ''): void {
  A.stopAll();
  const p = state.progress;
  const now = Date.now();
  const spec = P.levelSpec(p.n, p.level);
  const sess = T.sessionMs(state);
  const today = T.todayMs(state);
  const total = T.totalMs(state);
  const week = T.programWeek(state);
  const fresh = !state.startDate;
  const locked = lockedNow(now);
  const hasPost = state.tests.some((t) => t.kind === 'post');
  const next = p.n < 12 ? P.PITCH_ORDER[p.n] : null;

  const trainLabel = p.graduated ? '계속 연습하기' : p.oneTake ? '원테이크 도전' : fresh ? '훈련 시작' : '훈련 계속하기';
  const train = locked
    ? `<button class="primary big" disabled>원테이크까지 ${hoursMinutes((p.lockUntil ?? now) - now)} 남음</button>`
    : `<button class="primary big" data-act="train">${trainLabel} <kbd>Enter</kbd></button>`;

  const banners: string[] = [];
  if (notice) banners.push(`<div class="notice">${notice}</div>`);
  if (fresh && !state.tests.length) {
    banners.push(`
      <section class="card welcome">
        <h2>처음이시네요</h2>
        <p>훈련 전에 <b>사전 테스트</b>(144문제, 10분 정도)를 보면 8주 뒤에 얼마나 늘었는지 비교할 수 있어요.</p>
        <button class="secondary" data-act="test">사전 테스트 보기</button>
      </section>`);
  }
  if (p.graduated) {
    banners.push('<div class="notice good">졸업! 12음을 빠르고 정확하게 맞혔어요. 사후 테스트로 처음과 비교해 보세요.</div>');
  } else if (total >= T.TOTAL_GOAL_MS && !hasPost) {
    banners.push('<div class="notice good">25시간을 채웠어요. 사후 테스트로 처음과 비교해 보세요.</div>');
  }
  if (p.oneTake && !p.graduated) {
    banners.push(`<div class="notice">마지막 레벨을 3번 연속 통과했어요. ${locked ? '12시간 쉰 다음' : '이제'} 한 번에 통과하면(원테이크) 졸업이에요.</div>`);
  }

  const weekText = fresh ? '시작 전' : week <= T.PROGRAM_WEEKS ? `${week}주차 / 8주` : `8주 끝 (${week}주차)`;
  const weekMs = week ? T.weekMs(state, week) : 0;
  const left = Math.max(0, T.DAILY_GOAL_MS - today);

  render('home', `
    <header class="top">
      <div>
        <h1 class="logo">MOZA</h1>
        <p class="muted">성인 절대음감 훈련 · Wong et al. (2025) 프로토콜</p>
      </div>
      <nav>
        <button class="link" data-act="records">기록</button>
        <button class="link" data-act="test">테스트</button>
      </nav>
    </header>
    ${banners.join('')}
    <section class="card today">
      ${ringSVG(today, sess < T.MIN_SESSION_MS ? sess : 0)}
      <div>
        <p class="eyebrow">오늘</p>
        <h2>${left === 0 ? '오늘 목표 달성!' : `${minutes(left)} 더 하면 오늘 목표`}</h2>
        <p class="muted">하루 25분 · 한 번에 15분 넘게 해야 기록에 들어가요.</p>
        <p class="muted small" data-clock></p>
      </div>
    </section>
    <section class="card level">
      ${chromaSVG(p.n)}
      <div>
        <p class="eyebrow">레벨 ${spec.global} / ${P.TOTAL_LEVELS}</p>
        <h2>음 ${p.n}개 · ${spec.level}/24단계</h2>
        <p class="muted">${next !== null ? `다음에 추가될 음: ${noteLabel(next)}` : '12음 전부 학습 중'}</p>
        <div class="actions">${train}</div>
      </div>
    </section>
    <section class="stats">
      <div><span class="muted">기간</span><b>${weekText}</b></div>
      <div><span class="muted">이번 주</span><b>${hoursMinutes(weekMs)}</b><small class="muted">주 2시간 이상</small></div>
      <div><span class="muted">총 훈련</span><b>${hoursMinutes(total)}</b><small class="muted">/ 25시간</small></div>
      <div><span class="muted">연속</span><b>${T.streakDays(state)}일</b></div>
      <div><span class="muted">점수</span><b>${state.points.toLocaleString()}</b></div>
      <div><span class="muted">토큰</span><b>${state.tokens}</b><small class="muted">10개 = 2배 찬스</small></div>
    </section>
    ${aboutHTML()}
  `, {
    train: () => showPrep(),
    test: () => showTestIntro(),
    records: () => showRecords(),
  }, locked ? null : onEnter(showPrep));
}

// ---------- 레벨 ----------

const sampleButton = (pc: PitchClass, cls = '') =>
  `<button class="sample ${cls}" data-act="sample" data-pc="${pc}"><b>${P.PC_NAMES[pc]}</b><small>${P.SOLFEGE[pc]}</small></button>`;

// 필요한 악기 샘플을 다 받은 뒤에 fn을 실행한다
function withSounds(timbres: Timbre[], fn: () => void): void {
  Promise.all(timbres.map(A.load)).then(fn, () => showHome('소리를 불러오지 못했어요. 터미널에서 moza가 실행 중인지 확인해 주세요.'));
}

// 그 음을 세 옥타브에서 무작위 순서로 들려준다
function playSample(pc: PitchClass): void {
  touch();
  A.stopAll();
  withSounds(['piano'], () => P.shuffle([...P.OCTAVES]).forEach((o, k) => A.playNote('piano', P.midiOf(pc, o), 0.05 + k)));
}

function showPrep(): void {
  if (lockedNow()) return showHome();
  const p = state.progress;
  const spec = P.levelSpec(p.n, p.level);
  const set = P.pitchSet(p.n);
  const oob = P.outOfBound(p.n);
  const oneTake = p.oneTake && !p.graduated;
  const newPc = p.level === 1 && p.n > 1 ? P.PITCH_ORDER[p.n - 1] : null;
  if (!spec.feedback) A.prepareShepard();
  const tokenNote = spec.isFinal
    ? '각 음의 마지막 단계라 2배 찬스가 없어요.'
    : state.tokens >= TOKENS_PER_DOUBLE
      ? '토큰 10개를 써서 이번 레벨에 2배 찬스가 하나 숨어 있어요.'
      : `토큰 ${state.tokens}/10 · 레벨 정확도 60%·75%·90%마다 1개씩`;

  render('prep', `
    <header class="bar"><button class="link" data-act="home">← 홈</button><span class="muted small" data-clock></span></header>
    <section class="card">
      <p class="eyebrow">레벨 ${spec.global} / ${P.TOTAL_LEVELS}</p>
      <h1>음 ${p.n}개 · ${spec.level}/24단계</h1>
      ${oneTake ? '<p class="callout">원테이크: 이번 한 번에 통과하면 졸업이에요.</p>' : ''}
      ${newPc !== null ? `<p class="callout good">새 음이 추가됐어요: <b>${noteLabel(newPc)}</b></p>` : ''}
      <div class="chips">
        <span class="chip">통과 기준 <b>${pct(spec.criterion)}</b></span>
        <span class="chip">제한 시간 <b>${sec(spec.rtWindow)}</b></span>
        <span class="chip">${spec.feedback ? '정답 알려줌' : '정답 안 알려줌'}</span>
        <span class="chip">${spec.trials}문제</span>
      </div>
      ${spec.feedback ? '' : `<p class="hint">시작하면 ${SHEPARD_SEC}초 동안 계속 내려가는 소리(셰퍼드 톤)가 먼저 나와요. 방금 들은 음의 기억을 지워서 상대음감으로 맞히지 못하게 하는 장치예요.</p>`}
      ${oob.length ? `<p class="hint">학습 중인 음 바깥의 음(${[...oob].sort(byPitch).map(noteName).join(', ')})도 섞여 나와요. 이런 음이면 <b>범위 밖</b>(Space)을 누르세요.</p>` : ''}
      <p class="hint">${tokenNote}</p>
    </section>
    <section class="card">
      <h2>샘플 듣기</h2>
      <p class="hint">누르면 그 음을 세 옥타브에서 무작위 순서로 들려줘요. 원하는 만큼 들어도 돼요.</p>
      <div class="samples">${[...set].sort(byPitch).map((pc) => sampleButton(pc, pc === newPc ? 'new' : '')).join('')}</div>
    </section>
    <div class="actions"><button class="primary big" data-act="start">시작 <kbd>Enter</kbd></button></div>
  `, {
    home: () => showHome(),
    sample: ({ pc }) => playSample(Number(pc)),
    start: () => withSounds(['piano'], startLevel),
  }, onEnter(() => withSounds(['piano'], startLevel)));
}

function startLevel(): void {
  const p = state.progress;
  const spec = P.levelSpec(p.n, p.level);
  const mode: LevelMode = p.graduated ? 'free' : p.oneTake ? 'oneTake' : 'level';
  if (!state.startDate) state.startDate = T.dayKey(Date.now());
  touch();
  const trials = P.makeLevelTrials(p.n, spec.trials);
  const doubles = new Set<number>();
  let usesToken = false;
  if (!spec.isFinal) {
    trials.forEach((_, i) => { if (Math.random() < RANDOM_DOUBLE) doubles.add(i); });
    if (state.tokens >= TOKENS_PER_DOUBLE) {
      usesToken = true;
      doubles.add(Math.floor(Math.random() * trials.length));
    }
  }
  const quit = () => showHome('레벨을 중단했어요. 이번 레벨은 기록되지 않았어요.');
  const run = () => runTrials({
    name: 'train',
    title: `레벨 ${spec.global} · 음 ${p.n}개 · ${spec.level}/24`,
    trials,
    rtWindow: spec.rtWindow,
    feedback: spec.feedback,
    timbre: 'piano',
    activePcs: P.pitchSet(p.n),
    allowOut: P.outOfBound(p.n).length > 0,
    doubles,
    training: true,
    onDone: (results) => finishLevel(spec, mode, results, doubles, usesToken),
    onQuit: quit,
  });
  if (spec.feedback) run();
  else shepardThen(run, quit);
}

function recordTrials(results: TrialResult[]): void {
  state.totalTrials += results.length;
  for (const r of results) {
    if (r.answer === P.OUT) continue;
    const history = (state.pitchStats[r.pc] ??= []);
    history.push(r.correct);
    if (history.length > STATS_LIMIT) history.shift();
  }
}

function finishLevel(spec: LevelSpec, mode: LevelMode, results: TrialResult[], doubles: Set<number>, usesToken: boolean): void {
  const p = state.progress;
  const acc = P.accuracy(results, spec.rtWindow);
  const pass = P.passes(acc, spec.criterion);
  const points = results.reduce((s, r, i) => s + (r.correct ? (doubles.has(i) ? 2 : 1) : 0), 0);
  const tokens = P.tokensFor(acc);
  if (usesToken) state.tokens -= TOKENS_PER_DOUBLE;
  state.tokens += tokens;
  state.points += points;
  recordTrials(results);
  state.levelLog.push({ t: Date.now(), n: spec.n, level: spec.level, acc: Math.round(acc * 1000) / 1000, pass, mode });
  if (state.levelLog.length > LOG_LIMIT) state.levelLog.splice(0, state.levelLog.length - LOG_LIMIT);

  const out: LevelOutcome = { acc, pass, points, tokens, failStreak: 0, focusNext: false };
  if (mode === 'oneTake') {
    p.oneTake = false;
    p.lockUntil = null;
    if (pass) {
      p.graduated = true;
      p.graduatedAt = Date.now();
      out.graduated = true;
    } else {
      out.oneTakeFailed = true;
    }
  } else if (mode === 'level') {
    p.levelsSinceFocus += 1;
    p.failStreak = pass ? 0 : p.failStreak + 1;
    if (spec.global === P.TOTAL_LEVELS) {
      p.finalStreak = pass ? p.finalStreak + 1 : 0;
      out.finalStreak = p.finalStreak;
      if (p.finalStreak >= FINAL_STREAK) {
        p.finalStreak = 0;
        p.oneTake = true;
        p.lockUntil = Date.now() + ONE_TAKE_REST_MS;
        out.lockStarted = true;
      }
    } else if (pass && spec.isFinal) {
      p.n += 1;
      p.level = 1;
      out.newPc = P.PITCH_ORDER[p.n - 1];
    } else if (pass) {
      p.level += 1;
      out.jump = P.jumpTarget(results, spec);
    }
  }
  out.failStreak = p.failStreak;
  out.focusNext = mode === 'level' && !out.lockStarted && p.n >= FOCUS_MIN_PITCHES && p.levelsSinceFocus >= FOCUS_EVERY;
  S.save(state);
  showLevelResult(spec, mode, results, out);
}

function summaryHTML(results: TrialResult[], rtWindow: number, set: PitchClass[]): string {
  const rows = [...[...set].sort(byPitch), P.OUT].map((answer) => {
    const rs = results.filter((r) => r.answer === answer);
    if (!rs.length) return '';
    const hit = rs.filter((r) => P.isHit(r, rtWindow)).length;
    const misses: Record<string, number> = {};
    for (const r of rs) {
      if (P.isHit(r, rtWindow)) continue;
      const label = r.response === null ? '시간 초과' : r.response === r.answer ? '늦음' : noteName(r.response);
      misses[label] = (misses[label] ?? 0) + 1;
    }
    const missText = Object.entries(misses).map(([k, v]) => `${k}×${v}`).join(', ');
    return `
      <tr>
        <th>${noteLabel(answer)}</th>
        <td class="num">${hit}/${rs.length}</td>
        <td><div class="minibar"><div style="width:${(hit / rs.length) * 100}%"></div></div></td>
        <td class="muted">${missText || '—'}</td>
      </tr>`;
  }).join('');
  return `
    <section class="card">
      <h2>음별 결과</h2>
      <table class="summary">
        <thead><tr><th>나온 음</th><th>정답</th><th></th><th>틀린 답</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </section>`;
}

function showLevelResult(spec: LevelSpec, mode: LevelMode, results: TrialResult[], out: LevelOutcome): void {
  const p = state.progress;
  let headline = out.pass ? '통과' : '다시 도전';
  let detail = '';
  if (out.graduated) {
    headline = '졸업!';
    detail = '원테이크까지 통과했어요. 12음을 빠르고 정확하게 맞힐 수 있게 됐어요.';
  } else if (out.oneTakeFailed) {
    headline = '원테이크 실패';
    detail = '마지막 레벨을 다시 3번 연속 통과하면 원테이크에 또 도전할 수 있어요.';
  } else if (out.lockStarted) {
    headline = '3번 연속 통과!';
    detail = '이제 12시간 동안 훈련을 쉬고, 그다음 한 번에 통과하면(원테이크) 졸업이에요.';
  } else if (out.newPc !== undefined) {
    detail = `새 음이 추가돼요: <b>${noteLabel(out.newPc)}</b>`;
  } else if (out.finalStreak !== undefined && mode === 'level') {
    detail = `마지막 레벨 연속 통과 ${out.finalStreak}/${FINAL_STREAK}`;
  }

  const finished = out.lockStarted || out.graduated;
  const go = () => (out.focusNext ? showFocusIntro() : showPrep());
  const buttons: string[] = [];
  if (finished) {
    buttons.push('<button class="primary big" data-act="home">홈으로 <kbd>Enter</kbd></button>');
  } else {
    buttons.push(`<button class="primary big" data-act="next">${out.pass ? '다음 레벨' : '다시 하기'} <kbd>Enter</kbd></button>`);
    if (out.jump) buttons.push(`<button class="secondary" data-act="jump">레벨 ${P.levelSpec(spec.n, out.jump).global}로 건너뛰기</button>`);
    if (!out.pass && out.failStreak >= FAILS_BEFORE_EASIER && p.level > 2) {
      buttons.push('<button class="secondary" data-act="easier">한 단계 쉬운 레벨로</button>');
    }
    buttons.push('<button class="link" data-act="home">홈</button>');
  }

  render('result', `
    <header class="bar"><span class="muted">레벨 ${spec.global} · 음 ${spec.n}개 · ${spec.level}/24</span><span class="muted small" data-clock></span></header>
    <section class="card result ${out.pass ? 'pass' : 'fail'}">
      <p class="eyebrow">${headline}</p>
      <div class="big-num">${pct(out.acc)}</div>
      <p>통과 기준 ${pct(spec.criterion)} · 제한 시간 ${sec(spec.rtWindow)}</p>
      ${detail ? `<p class="callout ${out.pass ? 'good' : ''}">${detail}</p>` : ''}
      <p class="muted">+${out.points}점 · 토큰 +${out.tokens} (지금 ${state.tokens}개)${out.focusNext ? ' · 다음은 약점 집중 연습이에요' : ''}</p>
    </section>
    ${summaryHTML(results, spec.rtWindow, P.pitchSet(spec.n))}
    <div class="actions">${buttons.join('')}</div>
  `, {
    next: go,
    home: () => showHome(),
    jump: () => {
      p.level = out.jump!;
      S.save(state);
      go();
    },
    easier: () => {
      p.level = Math.max(1, 2 * Math.ceil(p.level / 2) - 3); // 이전 단계의 첫 레벨
      p.failStreak = 0;
      S.save(state);
      showPrep();
    },
  }, onEnter(finished ? () => showHome() : go));
}

// ---------- 약점 집중 연습 ----------

function showFocusIntro(): void {
  const p = state.progress;
  const set = P.pitchSet(p.n);
  const weak = P.weakestPitch(set, state.pitchStats);
  const rtWindow = P.levelSpec(p.n, p.level).rtWindow;
  const start = () => withSounds(['piano'], () => runFocus(weak, rtWindow));
  A.prepareShepard();
  render('focus', `
    <header class="bar"><button class="link" data-act="home">← 홈</button><span class="muted small" data-clock></span></header>
    <section class="card">
      <p class="eyebrow">15레벨마다 하는 약점 집중 연습</p>
      <h1>${noteLabel(weak)}</h1>
      <p>최근 정답률이 가장 낮은 음이에요. 문제의 절반이 이 음이에요.</p>
      <div class="chips">
        <span class="chip">1부: 정답 알려줌 12문제</span>
        <span class="chip">2부: 정답 안 알려줌 22문제</span>
        <span class="chip">제한 시간 <b>${sec(rtWindow)}</b></span>
      </div>
    </section>
    <section class="card"><h2>샘플 듣기</h2><div class="samples">${sampleButton(weak)}</div></section>
    <div class="actions"><button class="primary big" data-act="start">시작 <kbd>Enter</kbd></button></div>
  `, {
    home: () => showHome(),
    sample: ({ pc }) => playSample(Number(pc)),
    start,
  }, onEnter(start));
}

function runFocus(weak: PitchClass, rtWindow: number): void {
  const p = state.progress;
  p.levelsSinceFocus = 0;
  touch();
  const set = P.pitchSet(p.n);
  const quit = () => showHome('집중 연습을 중단했어요.');
  const base = { name: 'train', rtWindow, timbre: 'piano' as const, activePcs: set, allowOut: false, doubles: new Set<number>(), training: true, onQuit: quit };
  runTrials({
    ...base,
    title: `약점 집중 연습 · ${noteName(weak)} · 1/2`,
    trials: P.makeFocusTrials(set, weak, 12),
    feedback: true,
    onDone: (first) => shepardThen(() => runTrials({
      ...base,
      title: `약점 집중 연습 · ${noteName(weak)} · 2/2`,
      trials: P.makeFocusTrials(set, weak, 22),
      feedback: false,
      onDone: (second) => finishFocus(weak, rtWindow, first, second),
    }), quit),
  });
}

function finishFocus(weak: PitchClass, rtWindow: number, first: TrialResult[], second: TrialResult[]): void {
  const all = [...first, ...second];
  recordTrials(all);
  state.points += all.filter((r) => r.correct).length;
  S.save(state);
  const weakAcc = (rs: TrialResult[]) => P.accuracy(rs.filter((r) => r.pc === weak), rtWindow);
  render('result', `
    <header class="bar"><span class="muted">약점 집중 연습</span><span class="muted small" data-clock></span></header>
    <section class="card result pass">
      <p class="eyebrow">집중 연습 끝 · ${noteLabel(weak)}</p>
      <div class="big-num">${pct(weakAcc(second))}</div>
      <p>정답을 알려주지 않은 2부에서 ${noteName(weak)} 정답률 (1부 ${pct(weakAcc(first))})</p>
    </section>
    ${summaryHTML(second, rtWindow, P.pitchSet(state.progress.n))}
    <div class="actions"><button class="primary big" data-act="next">다음 레벨 <kbd>Enter</kbd></button><button class="link" data-act="home">홈</button></div>
  `, { next: () => showPrep(), home: () => showHome() }, onEnter(showPrep));
}

// ---------- 셰퍼드 톤 ----------

function shepardThen(next: () => void, onQuit: () => void): void {
  touch();
  let left = SHEPARD_SEC;
  render('shepard', `
    <section class="card center shepard">
      <p class="eyebrow">기억 지우기</p>
      <div class="countdown" data-left>${left}</div>
      <p class="muted">계속 내려가는 소리(셰퍼드 톤)를 듣는 동안 방금 들은 음의 기억이 흐려져요.<br>끝나면 정답을 알려주지 않는 문제가 바로 시작돼요.</p>
      <div class="sweep"><div style="animation-duration:${SHEPARD_SEC}s"></div></div>
      <button class="link" data-act="quit">그만하기</button>
    </section>
  `, { quit: onQuit });
  A.playShepard();
  const iv = setInterval(() => {
    left -= 1;
    const el = app.querySelector('[data-left]');
    if (el) el.textContent = String(left);
    if (left <= 0) {
      clearInterval(iv);
      touch();
      next();
    }
  }, 1000);
  stopCurrent = () => {
    clearInterval(iv);
    A.stopAll();
  };
}

// ---------- 문제 풀기 ----------

function padHTML(active: readonly PitchClass[], allowOut: boolean): string {
  const on = new Set(active);
  const key = (pc: PitchClass, cls: string, col: number) => `
    <button class="key ${cls}" style="grid-column:${col} / span 2" data-act="answer" data-pc="${pc}" ${on.has(pc) ? '' : 'disabled'}>
      <b>${P.PC_NAMES[pc]}</b><small>${P.SOLFEGE[pc]}</small><kbd>${KEY_CODES[pc].slice(3)}</kbd>
    </button>`;
  const whites = [0, 2, 4, 5, 7, 9, 11].map((pc, i) => key(pc, 'white', 2 * i + 1)).join('');
  const blacks = [[1, 2], [3, 4], [6, 8], [8, 10], [10, 12]].map(([pc, col]) => key(pc, 'black', col)).join('');
  return `
    <div class="pad">
      <div class="row">${blacks}</div>
      <div class="row">${whites}</div>
      ${allowOut ? `<button class="out-key" data-act="answer" data-pc="${P.OUT}">범위 밖 <kbd>Space</kbd></button>` : ''}
    </div>`;
}

function trialHTML(cfg: RunConfig): string {
  return `
    <header class="bar">
      <button class="link" data-act="quit">그만하기</button>
      <span class="title">${cfg.title}</span>
      <span class="count" data-count></span>
    </header>
    <section class="stage">
      <div class="orb" data-orb>♪</div>
      <div class="timer"><div class="timer-fill" data-timer></div></div>
      <p class="feedback" data-fb>&nbsp;</p>
      <p class="star" data-star hidden>★ 2배 찬스</p>
    </section>
    ${padHTML(cfg.activePcs, cfg.allowOut)}
    <footer class="trial-foot">
      <span>${cfg.feedback ? '정답 알려줌' : '정답 안 알려줌'} · 제한 ${sec(cfg.rtWindow)}</span>
      ${cfg.feedback && cfg.training ? `<span>점수 <b data-points>${state.points.toLocaleString()}</b></span>` : ''}
      ${cfg.training ? '<span data-clock></span>' : ''}
    </footer>`;
}

// 문제를 하나씩 들려주고 답을 받는다. 반응 시간은 소리가 실제로 나온 순간부터 잰다.
function runTrials(cfg: RunConfig): void {
  const total = cfg.trials.length;
  const results: TrialResult[] = [];
  let i = 0;
  let accepting = false;
  let cur: (A.Playback & { t: Trial }) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let shownPoints = state.points;

  render(cfg.name, trialHTML(cfg), {
    answer: ({ pc }) => respond(Number(pc)),
    quit: () => cfg.onQuit(),
  }, (e) => {
    if (e.code === 'Space' && cfg.allowOut) {
      e.preventDefault();
      respond(P.OUT);
      return;
    }
    const pc = KEY_CODES.indexOf(e.code);
    if (pc >= 0 && cfg.activePcs.includes(pc)) {
      e.preventDefault();
      respond(pc);
    }
  });
  stopCurrent = () => {
    done = true;
    clearTimeout(timer);
    A.stopAll();
  };

  const find = (k: string) => app.querySelector<HTMLElement>(`[data-${k}]`);
  const $count = find('count')!;
  const $fb = find('fb')!;
  const $timer = find('timer')!;
  const $orb = find('orb')!;
  const $star = find('star')!;
  const $points = find('points');
  const mark = (pc: Answer, cls: string) =>
    app.querySelector(`[data-act="answer"][data-pc="${pc}"]`)?.classList.add(cls);
  const clearMarks = () => {
    for (const b of app.querySelectorAll('.pressed, .right, .wrong, .reveal')) b.classList.remove('pressed', 'right', 'wrong', 'reveal');
  };

  timer = setTimeout(next, 700);

  function next(): void {
    if (done) return;
    if (i >= total) {
      done = true;
      cfg.onDone(results);
      return;
    }
    const t = cfg.trials[i];
    $count.textContent = `${i + 1} / ${total}`;
    $fb.textContent = ' ';
    $fb.className = 'feedback';
    $star.hidden = !cfg.doubles.has(i);
    clearMarks();
    cur = { t, ...A.playNote(cfg.timbre, t.midi) };
    debugTrial = t;
    const wait = Math.max(0, cur.onset - performance.now());
    $timer.style.transition = 'none';
    $timer.style.transform = 'scaleX(1)';
    void $timer.offsetWidth;
    $timer.style.transition = `transform ${cfg.rtWindow}ms linear ${wait}ms`;
    $timer.style.transform = 'scaleX(0)';
    $orb.classList.remove('sounding');
    void $orb.offsetWidth;
    $orb.classList.add('sounding');
    accepting = true;
    timer = setTimeout(() => respond(null), wait + cfg.rtWindow);
  }

  function respond(pc: Answer | null): void {
    if (!accepting || done || !cur) return;
    const now = performance.now();
    if (pc !== null && now < cur.onset) return; // 소리가 나기 전 입력은 무시
    accepting = false;
    clearTimeout(timer);
    const rt = pc === null ? null : Math.round(now - cur.onset);
    const correct = pc === cur.t.answer && rt !== null && rt <= cfg.rtWindow;
    results.push({ midi: cur.t.midi, pc: cur.t.pc, answer: cur.t.answer, response: pc, rt, correct });
    if (cfg.training && pc !== null) touch();

    const frozen = getComputedStyle($timer).transform;
    $timer.style.transition = 'none';
    $timer.style.transform = frozen;
    if (pc !== null) mark(pc, 'pressed');
    if (cfg.feedback) {
      if (correct) {
        $fb.textContent = cfg.doubles.has(i) ? '정답! ★ 2배' : '정답!';
        $fb.className = 'feedback good';
        mark(pc!, 'right');
      } else {
        $fb.textContent = `${pc === null ? '시간 초과' : '아니에요'} — 정답은 ${noteLabel(cur.t.answer)}`;
        $fb.className = 'feedback bad';
        if (pc !== null) mark(pc, 'wrong');
        mark(cur.t.answer, 'reveal');
      }
      if ($points && correct) {
        shownPoints += cfg.doubles.has(i) ? 2 : 1;
        $points.textContent = shownPoints.toLocaleString();
      }
    }
    i += 1;
    // 다음 음은 이번 음이 완전히 끝난 뒤에 (겹치면 비교 기준이 생긴다)
    const at = Math.max(now + (cfg.feedback ? 1000 : 600), cur.end + 400);
    timer = setTimeout(next, at - performance.now());
  }
}

// ---------- 테스트 ----------

function testKind(): TestKind {
  if (!state.startDate) return 'pre';
  return state.progress.graduated || T.totalMs(state) >= T.TOTAL_GOAL_MS ? 'post' : 'mid';
}

function showTestIntro(): void {
  const kind = testKind();
  const start = () => withSounds(['piano', 'guitar'], () => runTest(kind));
  render('test-intro', `
    <header class="bar"><button class="link" data-act="home">← 홈</button></header>
    <section class="card">
      <p class="eyebrow">${TEST_LABEL[kind]}</p>
      <h1>절대음감 테스트</h1>
      <ul class="rules">
        <li>144문제: 피아노 72문제, 이어서 처음 듣는 기타 소리 72문제</li>
        <li>12음 × 3옥타브(C4–B6). 연속된 두 음은 항상 한 옥타브보다 멀리 떨어져 나와요</li>
        <li>한 문제에 5초, 정답은 알려주지 않아요. 반음만 틀려도 오답이에요</li>
        <li>악기나 튜너 같은 기준음은 쓰지 마세요. 헤드폰을 권해요</li>
        <li>테스트 시간은 훈련 시간에 들어가지 않아요</li>
      </ul>
      <p class="hint">소리 크기는 잡음으로 맞춰요. 음높이 힌트가 되지 않게요.</p>
      <button class="secondary" data-act="noise">소리 크기 확인</button>
    </section>
    <div class="actions"><button class="primary big" data-act="start">시작 <kbd>Enter</kbd></button></div>
  `, { home: () => showHome(), noise: () => A.playNoise(), start }, onEnter(start));
}

function runTest(kind: TestKind): void {
  const blocks: { timbre: Timbre; name: string }[] = [{ timbre: 'piano', name: '피아노' }, { timbre: 'guitar', name: '기타' }];
  const all: (TrialResult & { timbre: Timbre })[] = [];
  const quit = () => showHome('테스트를 중단했어요. 결과는 저장되지 않았어요.');
  const runBlock = (b: number) => runTrials({
    name: 'test',
    title: `${TEST_LABEL[kind]} · ${blocks[b].name} (${b + 1}/2)`,
    trials: P.makeTestBlock(),
    rtWindow: P.TEST_RT,
    feedback: false,
    timbre: blocks[b].timbre,
    activePcs: P.ALL_PCS,
    allowOut: false,
    doubles: new Set(),
    training: false,
    onDone: (results) => {
      all.push(...results.map((r) => ({ ...r, timbre: blocks[b].timbre })));
      if (b === 0) showTestBreak(() => runBlock(1), quit);
      else finishTest(kind, all);
    },
    onQuit: quit,
  });
  runBlock(0);
}

function showTestBreak(next: () => void, quit: () => void): void {
  render('test-break', `
    <section class="card center">
      <p class="eyebrow">절반 끝</p>
      <h1>잠깐 쉬어요</h1>
      <p>이어서 <b>기타 소리</b>로 72문제를 봐요. 훈련하지 않은 음색에서도 음을 알아듣는지 보는 거예요.</p>
      <div class="actions center">
        <button class="primary big" data-act="next">계속 <kbd>Enter</kbd></button>
        <button class="link" data-act="quit">그만하기</button>
      </div>
    </section>
  `, { next, quit }, onEnter(next));
}

function finishTest(kind: TestKind, results: (TrialResult & { timbre: Timbre })[]): void {
  const p = state.progress;
  const entry: TestEntry = {
    t: Date.now(),
    kind,
    trainedMs: T.totalMs(state),
    level: P.levelSpec(p.n, p.level).global,
    ...P.scoreTest(results),
  };
  state.tests.push(entry);
  S.save(state);
  showTestResult(entry);
}

function showTestResult(entry: TestEntry): void {
  const base = state.tests.find((t) => t !== entry && t.kind === 'pre');
  const metrics: [string, (s: P.TimbreScore) => string][] = [
    ['정답률', (s) => pct(s.correct)],
    ['평균 오차', (s) => `${s.error.toFixed(2)}반음`],
    ['정답 반응 시간', (s) => (s.rt ? sec(s.rt) : '—')],
  ];
  const cell = (timbre: Timbre, fmt: (s: P.TimbreScore) => string) =>
    `<td><b>${fmt(entry[timbre])}</b>${base ? `<small class="muted">사전 ${fmt(base[timbre])}</small>` : ''}</td>`;
  const bars = P.ALL_PCS.map((pc) => `
    <div class="pcbar">
      <div class="col"><div style="height:${entry.piano.byPc[pc] * 100}%"></div></div>
      <span>${P.PC_NAMES[pc]}</span>
    </div>`).join('');
  render('test-result', `
    <header class="bar"><button class="link" data-act="home">← 홈</button></header>
    <section class="card result pass">
      <p class="eyebrow">${TEST_LABEL[entry.kind]} 결과 · ${shortDate(entry.t)}</p>
      <div class="big-num">${pct(entry.piano.correct)}</div>
      <p>피아노 정답률${base ? ` (사전 테스트 ${pct(base.piano.correct)})` : ''}</p>
      <p class="muted">참고: 아무 음이나 찍으면 8% 정도예요. 논문 참가자 평균은 훈련 전 13.9% → 훈련 후 31.7%였고, 가장 잘한 두 명은 89%, 78%였어요.</p>
    </section>
    <section class="card">
      <h2>자세히</h2>
      <table class="summary">
        <thead><tr><th></th><th>피아노 (훈련 음색)</th><th>기타 (낯선 음색)</th></tr></thead>
        <tbody>${metrics.map(([label, fmt]) => `<tr><th>${label}</th>${cell('piano', fmt)}${cell('guitar', fmt)}</tr>`).join('')}</tbody>
      </table>
    </section>
    <section class="card"><h2>음별 정답률 (피아노)</h2><div class="pcbars">${bars}</div></section>
    <div class="actions"><button class="primary big" data-act="home">홈으로 <kbd>Enter</kbd></button></div>
  `, { home: () => showHome() }, onEnter(() => showHome()));
}

// ---------- 기록 ----------

function dailyChartSVG(): string {
  if (!state.startDate) return '<p class="muted">아직 훈련 기록이 없어요.</p>';
  const totals = T.dailyTotals(state);
  const days: { key: string; ms: number; label: string }[] = [];
  const d = new Date();
  for (let k = 0; k < 56; k++) {
    const key = T.dayKey(d);
    days.unshift({ key, ms: totals.get(key) ?? 0, label: `${d.getMonth() + 1}/${d.getDate()}` });
    if (key <= state.startDate) break;
    d.setDate(d.getDate() - 1);
  }
  const w = 14;
  const h = 110;
  const cap = 60 * 60000;
  const goalY = h - (T.DAILY_GOAL_MS / cap) * h;
  const bars = days.map((day, k) => {
    const bh = (Math.min(day.ms, cap) / cap) * h;
    const cls = day.ms >= T.DAILY_GOAL_MS ? 'met' : '';
    const label = k % 7 === 0 ? `<text x="${k * w + w / 2}" y="${h + 16}" class="axis">${day.label}</text>` : '';
    return `<rect x="${k * w + 2}" y="${h - bh}" width="${w - 4}" height="${Math.max(bh, day.ms ? 2 : 0)}" rx="2" class="${cls}"><title>${day.label} ${minutes(day.ms)}</title></rect>${label}`;
  }).join('');
  return `
    <svg viewBox="0 0 ${Math.max(days.length, 7) * w} ${h + 22}" class="daily" preserveAspectRatio="xMinYMin meet">
      <line x1="0" x2="${days.length * w}" y1="${goalY}" y2="${goalY}" class="goal"/>
      ${bars}
    </svg>
    <p class="muted small">점선은 하루 목표 25분이에요. 15분 넘게 한 세션만 들어가요.</p>`;
}

function showRecords(): void {
  const log = state.levelLog;
  const passed = log.filter((l) => l.pass).length;
  const tests = [...state.tests].reverse().map((t) => `
    <tr>
      <td>${shortDate(t.t)}</td>
      <td>${TEST_LABEL[t.kind]}</td>
      <td class="num">${pct(t.piano.correct)}</td>
      <td class="num">${t.piano.error.toFixed(2)}</td>
      <td class="num">${pct(t.guitar.correct)}</td>
      <td class="num">${hoursMinutes(t.trainedMs)}</td>
    </tr>`).join('');
  const recent = log.slice(-12).reverse().map((l) => `
    <tr>
      <td>${shortDate(l.t)}</td>
      <td>레벨 ${P.levelSpec(l.n, l.level).global} (음 ${l.n}개 · ${l.level}/24)</td>
      <td class="num">${pct(l.acc)}</td>
      <td>${l.pass ? '통과' : '—'}</td>
    </tr>`).join('');
  render('records', `
    <header class="bar"><button class="link" data-act="home">← 홈</button><span class="muted small" data-clock></span></header>
    <section class="card">
      <h2>하루 훈련 시간</h2>
      ${dailyChartSVG()}
    </section>
    <section class="stats">
      <div><span class="muted">총 훈련</span><b>${hoursMinutes(T.totalMs(state))}</b></div>
      <div><span class="muted">푼 문제</span><b>${state.totalTrials.toLocaleString()}</b></div>
      <div><span class="muted">레벨 도전</span><b>${log.length}</b><small class="muted">통과 ${passed}</small></div>
    </section>
    <section class="card">
      <h2>테스트</h2>
      ${tests ? `
        <table class="summary">
          <thead><tr><th>날짜</th><th></th><th>피아노 정답률</th><th>평균 오차</th><th>기타 정답률</th><th>그때까지 훈련</th></tr></thead>
          <tbody>${tests}</tbody>
        </table>` : '<p class="muted">아직 본 테스트가 없어요.</p>'}
    </section>
    <section class="card">
      <h2>최근 레벨</h2>
      ${recent ? `<table class="summary"><tbody>${recent}</tbody></table>` : '<p class="muted">아직 도전한 레벨이 없어요.</p>'}
    </section>
    <p class="muted small">기록 파일: ~/.moza/state.json (하루 한 번 ~/.moza/backups 에 사본을 남겨요)</p>
  `, { home: () => showHome() });
}

// ---------- 시작 ----------

async function init(): Promise<void> {
  try {
    state = await S.load();
  } catch {
    app.innerHTML = '<section class="card"><h1>불러오지 못했어요</h1><p>터미널에서 <code>moza</code>를 다시 실행해 주세요.</p></section>';
    return;
  }
  S.onSaveError((err) => { document.getElementById('save-error')!.hidden = !err; });
  if (T.endIdleSession(state)) S.save(state);
  showHome();
  setInterval(tick, 1000);
  addEventListener('pagehide', () => S.flushOnExit());
  if (DEBUG) {
    window.moza = {
      get state() { return state; },
      get trial() { return debugTrial; },
      get screen() { return screen; },
      P,
      T,
    };
  }
}

void init();
