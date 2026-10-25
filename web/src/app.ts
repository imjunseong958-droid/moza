// MOZA — 성인 절대음감 훈련 앱
// 훈련 규칙은 protocol.ts, 소리는 audio.ts, 하루 목표 계산은 goal.ts, 저장은 store.ts에 있다.
import * as P from './protocol.ts';
import * as A from './audio.ts';
import * as G from './goal.ts';
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
  training: boolean;    // 훈련인지 (테스트가 아니라)
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
const FIRST_TONE_MS = 1000;                 // 문제 화면이 뜨고 첫 음까지
const FEEDBACK_GAP_MS = 2000;               // 정답을 알려주는 레벨: 답한 뒤 다음 음까지 (정답을 보는 시간)
const NEXT_GAP_MS = 1200;                   // 정답을 안 알려주는 레벨·테스트: 답한 뒤 다음 음까지
const AFTER_TONE_MS = 500;                  // 앞 음이 끝나고 최소 이만큼 지나야 다음 음 (붙으면 비교 기준이 생긴다)
const AWAY_MISSES = 2;                      // 연달아 답이 없으면 자리를 비운 것으로 보고 멈춘다
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
// 정답 안 알려주는 레벨을 끝낸 뒤 샘플을 듣지 않고 같은 레벨을 다시 하면 셰퍼드 톤을 건너뛴다.
// 논문에서 셰퍼드 톤은 들은 샘플 음의 기억을 지우는 장치라, 이때는 지울 기억이 없다. 원테이크는 그대로 튼다.
let shepardSkipLevel: number | null = null; // 그 레벨의 global 번호
const skipsShepard = (spec: LevelSpec) => !spec.feedback && !state.progress.oneTake && shepardSkipLevel === spec.global;

// ---------- 공통 ----------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const sec = (ms: number) => `${parseFloat((ms / 1000).toFixed(2))}초`;
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
  return p.oneTake && now < (p.lockUntil ?? 0);
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
  // 건반·▶가 포커스를 가져가면 Space·Enter에 다시 눌리므로 막는다
  if ((e.target as Element).closest('.key, .out-key, .orb')) e.preventDefault();
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

const todayCount = () => G.todayCount(state.levelLog);

function updateClocks(): void {
  for (const el of app.querySelectorAll('[data-clock]')) el.textContent = `오늘 ${todayCount()} / ${G.DAILY_GOAL}번`;
}

// ---------- 홈 ----------

function ringSVG(count: number): string {
  const r = 52;
  const c = 2 * Math.PI * r;
  const done = Math.min(1, count / G.DAILY_GOAL);
  return `
    <svg viewBox="0 0 120 120" class="ring" aria-label="오늘 레벨 ${count} / ${G.DAILY_GOAL}번">
      <circle cx="60" cy="60" r="${r}" class="track"/>
      ${done > 0 ? `<circle cx="60" cy="60" r="${r}" class="done" stroke-dasharray="${done * c} ${c}" transform="rotate(-90 60 60)"/>` : ''}
      <text x="60" y="62" class="ring-num">${count}</text>
      <text x="60" y="82" class="ring-sub">/ ${G.DAILY_GOAL}번</text>
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
        <li>하루 목표는 레벨 ${G.DAILY_GOAL}번 도전이에요. 떨어진 레벨도 1번으로 세요. 처음에는 하루에 음 하나(24단계) 넘게 나가고, 뒤로 갈수록 한 음에 며칠씩 걸려요.</li>
        <li>음은 자동으로 나와요. 답하면 잠시 뒤 다음 음이 나와요. 두 문제 연속 답이 없으면 멈추고, ▶(Enter)를 누르면 이어서 해요.</li>
        <li>단계가 오를수록 통과 기준이 20%에서 90%로 오르고 제한 시간이 줄어요. 마지막 단계는 음 1개일 때 1.18초, 12개일 때 2.03초예요.</li>
        <li>정답을 알려주는 레벨 다음에 알려주지 않는 레벨이 와요. 그 전에는 20초 셰퍼드 톤으로 방금 들은 음의 기억을 지워요. 같은 레벨을 다시 할 때는 샘플을 듣지 않았으면 건너뛰어요.</li>
        <li>학습 중인 음 바로 바깥의 음도 섞여 나와요. 그럴 땐 "범위 밖"을 눌러요.</li>
        <li>피아노 3옥타브(C4–B6)에서 무작위로 나와요. 높이가 아니라 음 이름(음 종류)을 익히는 훈련이에요.</li>
        <li>음 5개부터는 15레벨마다 가장 약한 음을 집중 연습해요.</li>
        <li>마지막 레벨을 3번 연속 통과하고, 12시간 쉰 뒤 한 번에 다시 통과하면 졸업이에요. 졸업하면 기록은 그대로 두고 F 1단계부터 다음 회차를 시작해요.</li>
      </ul>
      <p class="muted">근거: Wong, Cheung, Ngan &amp; Wong (2025), Psychonomic Bulletin &amp; Review. 음악인 12명이 8주 동안 평균 21시간 훈련해서 평균 7개 음을 익혔고, 2명은 12음 전부를 익혔어요.</p>
    </details>`;
}

function showHome(notice = ''): void {
  A.stopAll();
  const p = state.progress;
  const now = Date.now();
  const spec = P.levelSpec(p.n, p.level);
  const today = todayCount();
  const fresh = !state.startDate;
  const locked = lockedNow(now);
  const next = p.n < 12 ? P.PITCH_ORDER[p.n] : null;

  const trainLabel = p.oneTake ? '원테이크 도전' : fresh ? '훈련 시작' : '훈련 계속하기';
  const train = locked
    ? `<button class="primary big" disabled>원테이크까지 ${hoursMinutes((p.lockUntil ?? now) - now)} 남음</button>`
    : `<button class="primary big" data-act="train">${trainLabel} <kbd>Enter</kbd></button>`;

  const banners: string[] = [];
  if (notice) banners.push(`<div class="notice">${notice}</div>`);
  if (fresh && !state.tests.length) {
    banners.push(`
      <section class="card welcome">
        <h2>처음이시네요</h2>
        <p>훈련 전에 <b>사전 테스트</b>(144문제, 10분 정도)를 보면 나중에 얼마나 늘었는지 비교할 수 있어요.</p>
        <button class="secondary" data-act="test">사전 테스트 보기</button>
      </section>`);
  }
  if (postTestDue()) {
    banners.push(`<div class="notice good">졸업! 12음을 빠르고 정확하게 맞혔어요. 사후 테스트로 처음과 비교해 보세요. 훈련은 F 1단계부터 ${state.round}회차로 이어져요.</div>`);
  }
  if (p.oneTake) {
    banners.push(`<div class="notice">마지막 레벨을 3번 연속 통과했어요. ${locked ? '12시간 쉰 다음' : '이제'} 한 번에 통과하면(원테이크) 졸업이에요.</div>`);
  }

  const left = Math.max(0, G.DAILY_GOAL - today);

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
      ${ringSVG(today)}
      <div>
        <p class="eyebrow">오늘</p>
        <h2>${left === 0 ? '오늘 목표 달성!' : `${left}번 더 하면 오늘 목표`}</h2>
        <p class="muted">하루 레벨 ${G.DAILY_GOAL}번 도전 · 떨어진 레벨도 1번으로 세요.</p>
      </div>
    </section>
    <section class="card level">
      ${chromaSVG(p.n)}
      <div>
        <p class="eyebrow">${state.round > 1 ? `${state.round}회차 · ` : ''}레벨 ${spec.global} / ${P.TOTAL_LEVELS}</p>
        <h2>음 ${p.n}개 · ${spec.level}/24단계</h2>
        <p class="muted">${next !== null ? `다음에 추가될 음: ${noteLabel(next)}` : '12음 전부 학습 중'}</p>
        <div class="actions">${train}</div>
      </div>
    </section>
    <section class="stats">
      <div><span class="muted">회차</span><b>${state.round}회차</b><small class="muted">졸업 ${state.graduations.length}번</small></div>
      <div><span class="muted">연속</span><b>${G.streakDays(state.levelLog)}일</b><small class="muted">하루 ${G.DAILY_GOAL}번 채운 날</small></div>
      <div><span class="muted">푼 문제</span><b>${state.totalTrials.toLocaleString()}</b></div>
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
  shepardSkipLevel = null;
  A.stopAll();
  withSounds(['piano'], () => P.shuffle([...P.OCTAVES]).forEach((o, k) => A.playNote('piano', P.midiOf(pc, o), 0.05 + k)));
}

function showPrep(): void {
  if (lockedNow()) return showHome();
  const p = state.progress;
  const spec = P.levelSpec(p.n, p.level);
  const set = P.pitchSet(p.n);
  const oob = P.outOfBound(p.n);
  const oneTake = p.oneTake;
  const newPc = p.level === 1 && p.n > 1 ? P.PITCH_ORDER[p.n - 1] : null;
  if (!spec.feedback) A.prepareShepard();
  const shepardHint = spec.feedback
    ? ''
    : skipsShepard(spec)
      ? `같은 레벨을 다시 하는 거라 셰퍼드 톤 없이 바로 시작해요. 샘플을 들으면 ${SHEPARD_SEC}초 셰퍼드 톤이 다시 나와요.`
      : `시작하면 ${SHEPARD_SEC}초 동안 계속 내려가는 소리(셰퍼드 톤)가 먼저 나와요. 방금 들은 음의 기억을 지워서 상대음감으로 맞히지 못하게 하는 장치예요.`;
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
      ${oneTake ? '<p class="callout">원테이크: 이번 한 번에 통과하면 졸업이에요. 시작하면 기회를 쓴 거라, 중간에 그만두거나 창을 닫으면 실패로 쳐요.</p>' : ''}
      ${newPc !== null ? `<p class="callout good">새 음이 추가됐어요: <b>${noteLabel(newPc)}</b></p>` : ''}
      <div class="chips">
        <span class="chip">통과 기준 <b>${pct(spec.criterion)}</b></span>
        <span class="chip">제한 시간 <b>${sec(spec.rtWindow)}</b></span>
        <span class="chip">${spec.feedback ? '정답 알려줌' : '정답 안 알려줌'}</span>
        <span class="chip">${spec.trials}문제</span>
      </div>
      ${shepardHint ? `<p class="hint">${shepardHint}</p>` : ''}
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
  const mode: LevelMode = p.oneTake ? 'oneTake' : 'level';
  const skipShepard = skipsShepard(spec);
  shepardSkipLevel = null;
  if (!state.startDate) state.startDate = G.dayKey(Date.now());
  if (mode === 'oneTake') {
    // 원테이크는 시작하는 순간 기회를 쓴다. 중간에 그만두거나 창을 닫으면 실패와 같아서,
    // 마지막 레벨을 다시 3번 연속 통과해야 또 도전할 수 있다.
    p.oneTake = false;
    p.lockUntil = null;
    S.save(state);
  }
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
  const quit = () => showHome(mode === 'oneTake'
    ? '원테이크를 중간에 그만둬서 실패로 처리했어요. 마지막 레벨을 다시 3번 연속 통과하면 또 도전할 수 있어요.'
    : '레벨을 중단했어요. 이번 레벨은 기록되지 않았어요.');
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
  if (spec.feedback || skipShepard) run();
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
  shepardSkipLevel = spec.feedback ? null : spec.global;
  state.levelLog.push({ t: Date.now(), n: spec.n, level: spec.level, acc: Math.round(acc * 1000) / 1000, pass, mode });
  if (state.levelLog.length > LOG_LIMIT) state.levelLog.splice(0, state.levelLog.length - LOG_LIMIT);

  const out: LevelOutcome = { acc, pass, points, tokens, failStreak: 0, focusNext: false };
  if (mode === 'oneTake') {
    if (pass) out.graduated = true;
    else out.oneTakeFailed = true;
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
  if (out.graduated) {
    // 기록(점수·토큰·레벨 기록·테스트)은 그대로 두고 진도만 F 1단계로 돌려 다음 회차를 시작한다
    state.graduations.push(Date.now());
    state.round += 1;
    state.progress = S.freshProgress();
  }
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
    detail = `원테이크까지 통과했어요. 12음을 빠르고 정확하게 맞힐 수 있게 됐어요. 기록은 그대로 두고 F 1단계부터 ${state.round}회차를 시작해요.`;
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
  shepardSkipLevel = null; // 1부에서 정답을 알려준다
  S.save(state);
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
  let left = SHEPARD_SEC;
  render('shepard', `
    <section class="card center shepard">
      <p class="eyebrow">기억 지우기</p>
      <div class="countdown" data-left>${left}</div>
      <p class="muted">계속 내려가는 소리(셰퍼드 톤)를 듣는 동안 방금 들은 음의 기억이 흐려져요.<br>끝나면 정답을 알려주지 않는 문제로 넘어가요.</p>
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
      <button class="orb" data-act="play" data-orb aria-label="이어서 듣기" disabled>♪</button>
      <p class="orb-hint muted small" data-hint>&nbsp;</p>
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

// 문제를 하나씩 들려주고 답을 받는다. 음은 자동으로 나오고, 답하면 잠시 뒤 다음 음으로 넘어간다.
// 반응 시간은 소리가 실제로 나온 순간부터 잰다.
function runTrials(cfg: RunConfig): void {
  const total = cfg.trials.length;
  const results: TrialResult[] = [];
  let i = 0;
  let paused = false;    // 자리를 비운 것으로 보고 ▶(Enter)를 기다리는 중
  let accepting = false; // 답을 받는 중
  let missed = 0;        // 연달아 답이 없었던 문제 수
  let cur: (A.Playback & { t: Trial }) | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  let shownPoints = state.points;

  render(cfg.name, trialHTML(cfg), {
    play: () => resume(),
    answer: ({ pc }) => respond(Number(pc)),
    quit: () => cfg.onQuit(),
  }, (e) => {
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      resume();
      return;
    }
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
  const $orb = app.querySelector<HTMLButtonElement>('[data-orb]')!;
  const $hint = find('hint')!;
  const $star = find('star')!;
  const $points = find('points');
  const mark = (pc: Answer, cls: string) =>
    app.querySelector(`[data-act="answer"][data-pc="${pc}"]`)?.classList.add(cls);
  const clearMarks = () => {
    for (const b of app.querySelectorAll('.pressed, .right, .wrong, .reveal')) b.classList.remove('pressed', 'right', 'wrong', 'reveal');
  };

  schedule(performance.now() + FIRST_TONE_MS);

  // at 시각에 다음 음(마지막 문제 뒤에는 결과)으로 넘어간다.
  // at이 null이면 자리를 비운 것으로 보고 ▶(Enter)를 누를 때까지 멈춘다.
  function schedule(at: number | null): void {
    $count.textContent = `${Math.min(i + 1, total)} / ${total}`;
    const next = i >= total ? '결과' : i === 0 ? '첫 음' : '다음 음';
    if (at === null) {
      paused = true;
      $orb.disabled = false;
      $orb.classList.add('ready');
      $orb.textContent = '▶';
      $hint.textContent = `답이 없어서 멈췄어요 · 누르면 ${next} · Enter`;
      return;
    }
    $hint.textContent = `곧 ${next}`;
    timer = setTimeout(play, Math.max(0, at - performance.now()));
  }

  function resume(): void {
    if (!paused || done) return;
    paused = false;
    play();
  }

  function play(): void {
    if (done) return;
    if (i >= total) {
      done = true;
      cfg.onDone(results);
      return;
    }
    const t = cfg.trials[i];
    $orb.disabled = true;
    $orb.classList.remove('ready');
    $orb.textContent = '♪';
    $hint.textContent = '음을 듣고 답을 고르세요';
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
    $hint.textContent = ' ';
    missed = pc === null ? missed + 1 : 0;
    const at = missed >= AWAY_MISSES ? null : Math.max(now + (cfg.feedback ? FEEDBACK_GAP_MS : NEXT_GAP_MS), cur.end + AFTER_TONE_MS);
    timer = setTimeout(() => schedule(at), Math.max(0, cur.end + AFTER_TONE_MS - performance.now()));
  }
}

// ---------- 테스트 ----------

// 마지막으로 졸업한 뒤 사후 테스트를 아직 안 봤는지
function postTestDue(): boolean {
  const graduated = state.graduations.at(-1);
  return graduated !== undefined && !state.tests.some((t) => t.kind === 'post' && t.t > graduated);
}

function testKind(): TestKind {
  if (!state.startDate) return 'pre';
  return postTestDue() ? 'post' : 'mid';
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
        <li>음은 자동으로 나오고, 답하면 잠시 뒤 다음 음이 나와요. 음이 나온 뒤 5초 안에 답해야 하고, 정답은 알려주지 않아요. 반음만 틀려도 오답이에요</li>
        <li>악기나 튜너 같은 기준음은 쓰지 마세요. 헤드폰을 권해요</li>
        <li>테스트는 하루 목표(레벨 ${G.DAILY_GOAL}번)에 들어가지 않아요</li>
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
    round: state.round,
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
  const counts = G.dailyCounts(state.levelLog);
  const days: { key: string; count: number; label: string }[] = [];
  const d = new Date();
  for (let k = 0; k < 56; k++) {
    const key = G.dayKey(d);
    days.unshift({ key, count: counts.get(key) ?? 0, label: `${d.getMonth() + 1}/${d.getDate()}` });
    if (key <= state.startDate) break;
    d.setDate(d.getDate() - 1);
  }
  const w = 14;
  const h = 110;
  const cap = G.DAILY_GOAL * 2;
  const goalY = h - (G.DAILY_GOAL / cap) * h;
  const bars = days.map((day, k) => {
    const bh = (Math.min(day.count, cap) / cap) * h;
    const cls = day.count >= G.DAILY_GOAL ? 'met' : '';
    const label = k % 7 === 0 ? `<text x="${k * w + w / 2}" y="${h + 16}" class="axis">${day.label}</text>` : '';
    return `<rect x="${k * w + 2}" y="${h - bh}" width="${w - 4}" height="${Math.max(bh, day.count ? 2 : 0)}" rx="2" class="${cls}"><title>${day.label} ${day.count}번</title></rect>${label}`;
  }).join('');
  return `
    <svg viewBox="0 0 ${Math.max(days.length, 7) * w} ${h + 22}" class="daily" preserveAspectRatio="xMinYMin meet">
      <line x1="0" x2="${days.length * w}" y1="${goalY}" y2="${goalY}" class="goal"/>
      ${bars}
    </svg>
    <p class="muted small">점선은 하루 목표 레벨 ${G.DAILY_GOAL}번이에요. 떨어진 레벨도 1번으로 세요.</p>`;
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
      <td class="num">${(t.round ?? 1) > 1 ? `${t.round}회차 · ` : ''}레벨 ${t.level}</td>
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
      <h2>하루 레벨 도전</h2>
      ${dailyChartSVG()}
    </section>
    <section class="stats">
      <div><span class="muted">회차</span><b>${state.round}회차</b><small class="muted">졸업 ${state.graduations.length}번</small></div>
      <div><span class="muted">푼 문제</span><b>${state.totalTrials.toLocaleString()}</b></div>
      <div><span class="muted">레벨 도전</span><b>${log.length}</b><small class="muted">통과 ${passed}</small></div>
    </section>
    <section class="card">
      <h2>테스트</h2>
      ${tests ? `
        <table class="summary">
          <thead><tr><th>날짜</th><th></th><th>피아노 정답률</th><th>평균 오차</th><th>기타 정답률</th><th>그때 진도</th></tr></thead>
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
  showHome();
  addEventListener('pagehide', () => S.flushOnExit());
  if (DEBUG) {
    window.moza = {
      get state() { return state; },
      get trial() { return debugTrial; },
      get screen() { return screen; },
      P,
      G,
    };
  }
}

void init();
