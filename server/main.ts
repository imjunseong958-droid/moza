// moza — 성인 절대음감 훈련 앱 실행기.
// 터미널에서 `moza`를 치면 로컬 서버를 띄우고 브라우저로 앱을 연다.
// 브라우저 코드(web/src/*.ts)는 보낼 때 타입만 지워서 보내므로 빌드 단계가 없다.
// 기록은 ~/.moza/state.json 에 저장하고, 하루에 한 번 backups/ 에 사본을 남긴다.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { homedir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = resolve(import.meta.dirname, '..');
const WEB_DIR = join(ROOT, 'web');
const DEFAULT_PORT = 4810;
const MAX_BODY = 20 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
};
const HELP = `사용법: moza [옵션]

성인 절대음감 훈련 앱을 브라우저로 연다.

옵션:
  --port <번호>       서버 포트 (기본 ${DEFAULT_PORT})
  --no-open           브라우저를 자동으로 열지 않는다
  --data-dir <폴더>   기록 폴더 (기본 ~/.moza, MOZA_DATA_DIR로도 지정 가능)
  -h, --help          이 도움말`;

function send(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: string | Buffer) =>
  send(res, status, 'application/json; charset=utf-8', body);

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        fail(new Error('body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => done(Buffer.concat(chunks)));
    req.on('error', fail);
  });
}

function localDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stateStore(dataDir: string) {
  const file = join(dataDir, 'state.json');
  let queue: Promise<void> = Promise.resolve();

  async function write(body: Buffer): Promise<void> {
    await mkdir(dataDir, { recursive: true });
    if (existsSync(file)) {
      const backup = join(dataDir, 'backups', `state-${localDate()}.json`);
      if (!existsSync(backup)) {
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(file, backup);
      }
    }
    const tmp = `${file}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
  }

  return {
    file,
    read: async (): Promise<Buffer | string> => (existsSync(file) ? readFile(file) : 'null'),
    // 저장 요청이 겹쳐도 차례대로 쓴다
    save(body: Buffer): Promise<void> {
      queue = queue.then(() => write(body));
      return queue;
    },
  };
}

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + sep)) return send(res, 403, 'text/plain; charset=utf-8', 'forbidden');
  let body: Buffer | string;
  try {
    body = await readFile(file);
  } catch {
    return send(res, 404, 'text/plain; charset=utf-8', 'not found');
  }
  const ext = extname(file);
  if (ext === '.ts') body = stripTypeScriptTypes(body.toString('utf8'), { mode: 'strip', sourceUrl: pathname });
  send(res, 200, CONTENT_TYPES[ext] ?? 'application/octet-stream', body);
}

function makeHandler(store: ReturnType<typeof stateStore>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/api/ping') return sendJson(res, 200, '{"app":"moza"}');
    if (pathname === '/api/state') {
      if (req.method === 'GET') return sendJson(res, 200, await store.read());
      // 창을 닫을 때 보내는 sendBeacon은 POST로 온다
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await readBody(req);
        try {
          JSON.parse(body.toString('utf8'));
        } catch {
          return sendJson(res, 400, '{"error":"bad json"}');
        }
        await store.save(body);
        return sendJson(res, 200, '{"ok":true}');
      }
      return sendJson(res, 405, '{"error":"method not allowed"}');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, '{"error":"method not allowed"}');
    return serveStatic(pathname, res);
  };
}

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(500) });
    const data = (await res.json()) as { app?: string };
    return data.app === 'moza';
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`브라우저를 열지 못했어요. 직접 열어 주세요: ${url}`));
  child.unref();
}

async function main(): Promise<void> {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: 'string', default: String(DEFAULT_PORT) },
        'no-open': { type: 'boolean', default: false },
        'data-dir': { type: 'string', default: process.env.MOZA_DATA_DIR ?? join(homedir(), '.moza') },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  const port = Number(values.port);
  const url = `http://127.0.0.1:${port}/`;

  if (await alreadyRunning(port)) {
    console.log(`MOZA가 이미 실행 중이에요: ${url}`);
    if (!values['no-open']) openBrowser(url);
    return;
  }

  const store = stateStore(resolve(values['data-dir']));
  const handle = makeHandler(store);
  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', err.message);
    });
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE'
      ? `포트 ${port}을(를) 다른 프로그램이 쓰고 있어요. --port 로 다른 포트를 지정해 주세요.`
      : err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`MOZA 실행 중: ${url}`);
    console.log(`기록 파일: ${store.file}`);
    console.log('끝내려면 Ctrl+C');
    if (!values['no-open']) openBrowser(url);
  });
  process.on('SIGINT', () => {
    console.log('\nMOZA를 종료했어요.');
    server.close();
    process.exit(0);
  });
}

await main();
