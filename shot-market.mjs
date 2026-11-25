/** 生成市场用的两张截图：assets/shot-1.png（面板）、assets/shot-2.png（数据库编辑页）。 */
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { GeneralBook } from './src/generals.ts';
import { SlangBook } from './src/slang.ts';
import { startEditor } from './src/editor.ts';
import { ROOT } from './dev.mjs';

const tmp = join(ROOT, '.tmp-market');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
mkdirSync(join(ROOT, 'assets'), { recursive: true });

// 1) 静态服务：给面板预览页用
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const staticSrv = createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]).replace(/^\/+/, '') || 'panel-preview.html';
  try {
    const body = readFileSync(join(ROOT, rel));
    res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(17794, '127.0.0.1');

// 2) 编辑器：给库页面用
const book = new GeneralBook(join(ROOT, 'data/generals.json'), join(tmp, 'generals-user.json'));
const slang = new SlangBook(join(ROOT, 'data/slang.json'), join(tmp, 'slang-user.json'));
const editor = await startEditor({
  port: 17795,
  generals: book,
  slang,
  learnGeneral: async () => null,
  log: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
});
console.log('editor', editor.url, 'books', book.size, slang.size);

const EDGE = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/** 截一张；返回 Promise，超时就杀掉，避免 headless 卡死。 */
function shot(url, out, w, h, scale) {
  return new Promise((resolve) => {
    const child = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
      '--user-data-dir=' + join(tmp, 'edge-' + w),
      `--window-size=${w},${h}`,
      `--force-device-scale-factor=${scale}`,
      '--virtual-time-budget=6000',
      '--screenshot=' + out,
      url,
    ], { stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 25000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let size = 0;
      try { size = statSync(out).size; } catch {}
      resolve({ code, size });
    });
  });
}

const s1 = await shot('http://127.0.0.1:17794/panel-preview.html', join(ROOT, 'assets/shot-1.png'), 440, 470, 2);
console.log('shot-1', JSON.stringify(s1));
const s2 = await shot('http://127.0.0.1:17795/#generals/姜维', join(ROOT, 'assets/shot-2.png'), 1280, 820, 1.5);
console.log('shot-2', JSON.stringify(s2));

await editor.close();
staticSrv.close();
rmSync(tmp, { recursive: true, force: true });
console.log('done');
