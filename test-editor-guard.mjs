/**
 * 编辑页的跨站防线回归测试。
 * 用假 host 起一个真的编辑器，然后按浏览器/命令行两种姿势敲写接口：
 *  - 跨站 Origin、text/plain、跨站 Sec-Fetch-Site 必须被拒
 *  - 本页 Origin + JSON、无 Origin + JSON（curl）必须放行
 * 跑：node test-editor-guard.mjs
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GeneralBook } from './src/generals.ts';
import { SlangBook } from './src/slang.ts';
import { startEditor } from './src/editor.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const dataDir = await mkdtemp(join(tmpdir(), 'gb-guard-'));
const log = { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} };

const generals = new GeneralBook(join(ROOT, 'data/generals.json'), join(dataDir, 'generals-user.json'));
const slang = new SlangBook(join(ROOT, 'data/slang.json'), join(dataDir, 'slang-user.json'));

const editor = await startEditor({ port: 17811, generals, slang, log });
const base = editor.url.replace(/\/$/, '');
const origin = base;

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}：期望 ${expected}，实际 ${actual}`);
  ok ? pass++ : fail++;
}

async function post(path, { headers = {}, body } = {}) {
  const res = await fetch(base + path, { method: 'POST', headers, body });
  return res.status;
}

const generalBody = JSON.stringify({
  name: '守卫测试将',
  kingdom: '群',
  hp: 3,
  skills: [{ name: '测', text: '测试用' }],
});

try {
  // 1. 读接口不受影响
  check('GET /api/meta', (await fetch(base + '/api/meta')).status, 200);
  check('GET /api/generals', (await fetch(base + '/api/generals')).status, 200);

  // 2. 跨站 Origin：拦
  check(
    '跨站 Origin + JSON',
    await post('/api/generals', {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: generalBody,
    }),
    403,
  );

  // 3. 跨站 Sec-Fetch-Site：拦
  check(
    'Sec-Fetch-Site: cross-site',
    await post('/api/slang', {
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ term: '跨站', meaning: 'x' }),
    }),
    403,
  );

  // 4. 本页 Origin 但 text/plain（跨站简单请求的姿势）：拦
  check(
    '本页 Origin + text/plain',
    await post('/api/generals', {
      headers: { 'content-type': 'text/plain', origin },
      body: generalBody,
    }),
    415,
  );

  // 5. 没 Origin、text/plain（老式脚本/表单）：拦
  check(
    '无 Origin + text/plain',
    await post('/api/generals', { headers: { 'content-type': 'text/plain' }, body: generalBody }),
    415,
  );

  // 6. 本页 Origin + JSON：放行
  check(
    '本页 Origin + JSON',
    await post('/api/generals', {
      headers: { 'content-type': 'application/json', origin },
      body: generalBody,
    }),
    200,
  );
  check('写入后能查到', generals.lookup('守卫测试将') ? 200 : 0, 200);

  // 7. 没 Origin + JSON（curl 那种）：放行
  check(
    '无 Origin + JSON（curl）',
    await post('/api/slang', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: '守卫测试词', meaning: '测试用释义' }),
    }),
    200,
  );

  // 8. 坏 JSON：400 而不是 500
  check(
    '坏 JSON',
    await post('/api/slang', { headers: { 'content-type': 'application/json' }, body: '{"term":' }),
    400,
  );

  // 9. DELETE 无请求体：本页 Origin 放行
  const del = await fetch(base + '/api/slang?term=' + encodeURIComponent('守卫测试词'), {
    method: 'DELETE',
    headers: { origin },
  });
  check('DELETE 本页 Origin', del.status, 200);

  // 10. DELETE 跨站 Origin：拦
  const delEvil = await fetch(base + '/api/slang?term=' + encodeURIComponent('守卫测试词'), {
    method: 'DELETE',
    headers: { origin: 'http://evil.example' },
  });
  check('DELETE 跨站 Origin', delEvil.status, 403);

  // 11. 采集接口也走同一道防线
  check(
    'harvest/accept 跨站',
    await post('/api/harvest/accept', {
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ term: 'x' }),
    }),
    403,
  );
} finally {
  await editor.close();
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
