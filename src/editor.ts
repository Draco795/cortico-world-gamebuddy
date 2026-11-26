/**
 * 数据库编辑器：一个本地小网页，用来直接改武将库和黑话库。
 *
 * 为什么是独立的 HTTP 页面而不是面板里塞表单：改数据库是"坐着慢慢敲"的活，
 * 面板空间小、还得在宠物窗口里操作。一个 127.0.0.1 的页面可以用浏览器打开、
 * 能复制粘贴一整段技能描述、改完立刻生效（写的是 dataDir 下的用户库）。
 *
 * 只监听回环地址，没有鉴权——同机进程可访问，但不对外暴露。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { General, GeneralSkill } from './generals.ts';
import { GeneralBook } from './generals.ts';
import { KIND_LABEL, SlangBook, type SlangEntry, type SlangKind } from './slang.ts';
import type { Harvest } from './harvest.ts';

export interface EditorOptions {
  port: number;
  host?: string;
  generals: GeneralBook;
  slang: SlangBook;
  /** 直播采集：有它才开「采集」页签 */
  harvest?: Harvest;
  /** 采集页的「联网补库」按钮 */
  learnGeneral?: (name: string) => Promise<General | null>;
  log: { info(msg: string): void; warn(msg: string): void };
}

export interface EditorHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MAX_BODY = 2 * 1024 * 1024;
const KINDS: SlangKind[] = ['nickname', 'meme', 'jargon', 'card'];

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 请求体不合法（非法 JSON、跨站、Content-Type 不对）时抛这个，由顶层 catch 回对应状态码。 */
class BadRequest extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/**
 * 写接口的跨站防线（三道一起上，任何一道独立生效）：
 * ① `Sec-Fetch-Site` 只能是同源或 none——现代浏览器一定带这个头，跨站页面触发不了 same-origin；
 * ② 有 `Origin` 就必须是本页（127.0.0.1 / localhost + 同一端口）；
 * ③ 带请求体就要求 `application/json`——跨站带这个头会先发预检，浏览器会拦下，而 text/plain 的
 *    跨站简单请求碰不到 ③。
 * 为什么不全靠 Origin：老浏览器/命令行客户端可能不带；为什么不全靠 Content-Type：GET/无体请求没有它。
 */
function isSameOrigin(req: IncomingMessage, origin: string): boolean {
  const hostHeader = String(req.headers.host ?? '');
  if (!hostHeader) return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost' && parsed.hostname !== '::1') {
    return false;
  }
  const originPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  const hostPort = hostHeader.includes(':') ? (hostHeader.split(':').pop() ?? '') : '80';
  return originPort === hostPort;
}

function guardWrite(req: IncomingMessage): void {
  const site = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new BadRequest(`拒绝跨站写入（Sec-Fetch-Site: ${site}）`, 403);
  }

  const origin = req.headers.origin;
  if (origin && !isSameOrigin(req, origin)) {
    throw new BadRequest(`拒绝跨站写入（Origin 不是本页：${origin}）`, 403);
  }

  const hasBody =
    req.headers['content-length'] !== undefined || req.headers['transfer-encoding'] !== undefined;
  if (hasBody) {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      throw new BadRequest('写接口只接受 application/json（跨站表单发不出这个头）', 415);
    }
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BadRequest(`请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new BadRequest('请求体要是一个 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function parseSkills(value: unknown): GeneralSkill[] {
  if (!Array.isArray(value)) return [];
  const out: GeneralSkill[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as { name?: unknown; text?: unknown };
    const name = asString(item.name);
    const text = asString(item.text);
    if (name && text) out.push({ name, text });
  }
  return out;
}

export async function startEditor(opts: EditorOptions): Promise<EditorHandle> {
  const host = opts.host ?? '127.0.0.1';
  const server = createServer((req, res) => {
    void handle(req, res, opts);
  });

  const port = await listenWithFallback(server, host, opts.port);
  const url = `http://${host}:${port}/`;
  opts.log.info(`数据库编辑器：${url}（武将 ${opts.generals.size} 条 / 黑话 ${opts.slang.size} 条）`);

  return {
    url,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // 页面开着长连接时 close 会等；这里给个上限，别让 stop() 挂住
        setTimeout(resolve, 800).unref?.();
      }),
  };
}

function listenWithFallback(server: Server, host: string, preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = (port: number): void => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        // 端口被占：往后挪几个再试，别让整个世界上不起来
        if (error.code === 'EADDRINUSE' && attempt < 12) {
          attempt += 1;
          tryOnce(port + 1);
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    };
    tryOnce(preferred);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: EditorOptions): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  try {
    // 写接口先过跨站防线：本页 Origin + JSON Content-Type，别让任意网页能往库里塞东西
    if (method !== 'GET' && method !== 'HEAD') guardWrite(req);

    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = PAGE;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // 别让别的页面把编辑页塞进 iframe 里点（点击劫持）
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return;
    }

    if (method === 'GET' && path === '/api/meta') {
      json(res, 200, {
        ok: true,
        generals: opts.generals.size,
        generalsBuiltin: opts.generals.builtinSize,
        slang: opts.slang.size,
        slangBuiltin: opts.slang.builtinSize,
        kinds: KINDS.map((kind) => ({ kind, label: KIND_LABEL[kind] })),
      });
      return;
    }

    if (path === '/api/generals') {
      if (method === 'GET') {
        json(res, 200, { ok: true, items: opts.generals.list() });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const name = asString(body.name);
        if (!name) {
          json(res, 400, { ok: false, error: '武将名不能为空' });
          return;
        }
        const skills = parseSkills(body.skills);
        if (skills.length === 0) {
          json(res, 400, { ok: false, error: '至少要有一个技能（技能名 + 描述）' });
          return;
        }
        const hpRaw = body.hp;
        const hp = typeof hpRaw === 'number' ? hpRaw : Number.parseInt(String(hpRaw ?? ''), 10);
        const saved: General = opts.generals.teach({
          name,
          kingdom: asString(body.kingdom) || undefined,
          hp: Number.isFinite(hp) && hp > 0 ? hp : undefined,
          skills,
          play: asString(body.play) || undefined,
          counter: asString(body.counter) || undefined,
          source: 'editor',
        });
        json(res, 200, { ok: true, item: saved, total: opts.generals.size });
        return;
      }
      if (method === 'DELETE') {
        const name = url.searchParams.get('name') ?? '';
        if (!name) {
          json(res, 400, { ok: false, error: '缺少 name' });
          return;
        }
        if (opts.generals.isBuiltin(name) && !opts.generals.list().some((g) => g.name === name && g.source === 'editor')) {
          // 内置条目本身删不掉；已经写过覆盖版的才允许删掉覆盖版
          json(res, 409, { ok: false, error: '这是内置条目，不能删除。想要不同内容，直接改成覆盖版保存即可。' });
          return;
        }
        const removed = opts.generals.remove(name);
        json(res, removed ? 200 : 404, removed ? { ok: true, total: opts.generals.size } : { ok: false, error: '用户库里没有这条' });
        return;
      }
    }

    if (path === '/api/slang') {
      if (method === 'GET') {
        json(res, 200, { ok: true, items: opts.slang.list() });
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const term = asString(body.term);
        const meaning = asString(body.meaning);
        if (!term || !meaning) {
          json(res, 400, { ok: false, error: '词条和释义都要填' });
          return;
        }
        const kindRaw = asString(body.kind);
        const kind = (KINDS.includes(kindRaw as SlangKind) ? kindRaw : 'jargon') as SlangKind;
        const split = (value: unknown): string[] =>
          asString(value)
            .split(/[,，、;；\s]+/u)
            .map((part) => part.trim())
            .filter((part) => part !== '');
        const entry: SlangEntry = {
          term,
          kind,
          aliases: split(body.aliases),
          generals: split(body.generals),
          meaning,
          note: asString(body.note) || undefined,
          source: 'editor',
        };
        json(res, 200, { ok: true, item: opts.slang.teach(entry), total: opts.slang.size });
        return;
      }
      if (method === 'DELETE') {
        const term = url.searchParams.get('term') ?? '';
        if (!term) {
          json(res, 400, { ok: false, error: '缺少 term' });
          return;
        }
        const removed = opts.slang.remove(term);
        json(res, removed ? 200 : 404, removed ? { ok: true, total: opts.slang.size } : { ok: false, error: '用户库里没有这条（内置条目删不掉，可以写同名覆盖）' });
        return;
      }
    }

    if (path === '/api/harvest') {
      if (method !== 'GET') {
        json(res, 405, { ok: false, error: '只支持 GET' });
        return;
      }
      const harvest = opts.harvest;
      if (!harvest) {
        json(res, 200, { ok: false, error: '直播采集没开（配置里的 harvest 关掉了）' });
        return;
      }
      json(res, 200, {
        ok: true,
        stats: harvest.stats(),
        generals: harvest.generalHits(120),
        candidates: harvest.candidates(120),
        recent: harvest.recentDanmaku(40),
      });
      return;
    }

    if (path === '/api/harvest/accept' && method === 'POST') {
      const harvest = opts.harvest;
      if (!harvest) {
        json(res, 400, { ok: false, error: '直播采集没开' });
        return;
      }
      const body = await readJson(req);
      const term = asString(body.term);
      if (!term) {
        json(res, 400, { ok: false, error: '缺少 term' });
        return;
      }
      // 释义没填就先占个位，主人在黑话页补一句即可
      const meaning = asString(body.meaning) || '（待补：这条是从直播弹幕里捡的，补一句释义就行）';
      const saved = opts.slang.teach({ term, kind: 'jargon', meaning, source: 'harvest' });
      harvest.accept(term);
      harvest.save(true);
      json(res, 200, { ok: true, item: saved, total: opts.slang.size });
      return;
    }

    if (path === '/api/harvest/ignore' && method === 'POST') {
      const harvest = opts.harvest;
      if (!harvest) {
        json(res, 400, { ok: false, error: '直播采集没开' });
        return;
      }
      const body = await readJson(req);
      const term = asString(body.term);
      if (!term) {
        json(res, 400, { ok: false, error: '缺少 term' });
        return;
      }
      harvest.ignore(term);
      harvest.save(true);
      json(res, 200, { ok: true, total: harvest.candidates(200).length });
      return;
    }

    if (path === '/api/harvest/learn' && method === 'POST') {
      const body = await readJson(req);
      const name = asString(body.name);
      if (!name) {
        json(res, 400, { ok: false, error: '缺少 name' });
        return;
      }
      if (!opts.learnGeneral) {
        json(res, 400, { ok: false, error: '这个版本没接联网补库' });
        return;
      }
      const learned = await opts.learnGeneral(name);
      if (learned) opts.harvest?.markLearned(name);
      opts.harvest?.save(true);
      json(
        res,
        learned ? 200 : 404,
        learned
          ? { ok: true, item: learned }
          : { ok: false, error: '联网也没查到，可能得在「武将库」页手动新建一条' },
      );
      return;
    }

    json(res, 404, { ok: false, error: `没有这个接口：${method} ${path}` });
  } catch (error) {
    // 交叉校验失败（跨站 / Content-Type 不对 / JSON 坏）走 4xx，其余才是 500
    const status = error instanceof BadRequest ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    if (status >= 500) {
      opts.log.warn(`编辑器请求失败 ${method} ${path}：${message}`);
    } else {
      opts.log.info(`编辑器拒绝请求 ${method} ${path}（${status}）：${message}`);
    }
    json(res, status, { ok: false, error: message });
  }
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>陪玩搭子-三国杀 · 数据库编辑器</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #14161c; --panel: #1b1e26; --line: #2a2f3a; --fg: #e7e9ee;
    --dim: #8b93a5; --accent: #6ea8ff; --ok: #4ecb8f; --bad: #ef6b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--fg); height: 100vh; display: flex; flex-direction: column; }
  header { padding: 14px 18px 0; border-bottom: 1px solid var(--line); background: var(--panel); }
  h1 { margin: 0 0 10px; font-size: 17px; font-weight: 600; letter-spacing: .02em; }
  h1 small { color: var(--dim); font-weight: 400; font-size: 12px; margin-left: 8px; }
  .tabs { display: flex; gap: 6px; }
  .tabs button { appearance: none; border: 1px solid var(--line); border-bottom: none; background: transparent; color: var(--dim); padding: 8px 16px; border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; }
  .tabs button.on { background: var(--bg); color: var(--fg); border-color: var(--line); }
  .tabs .count { color: var(--dim); font-size: 12px; }
  main { flex: 1; display: flex; min-height: 0; }
  .list-pane { width: 300px; border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
  .toolbar { display: flex; gap: 8px; padding: 10px; }
  input, select, textarea, button { font: inherit; color: var(--fg); }
  input[type=text], input[type=search], input[type=number], select, textarea {
    background: #12141a; border: 1px solid var(--line); border-radius: 7px; padding: 8px 10px; width: 100%; outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--accent); }
  textarea { resize: vertical; min-height: 76px; }
  .btn { background: #232936; border: 1px solid var(--line); border-radius: 7px; padding: 8px 14px; cursor: pointer; white-space: nowrap; }
  .btn:hover { background: #2b3242; }
  .btn.primary { background: #2f5ea8; border-color: #3a6dbb; }
  .btn.primary:hover { background: #356abd; }
  .btn.danger { color: var(--bad); border-color: #4a2b2b; }
  .btn.danger:hover { background: #2a1c1c; }
  ul.list { list-style: none; margin: 0; padding: 0 6px 12px; overflow: auto; flex: 1; }
  ul.list li { padding: 8px 10px; border-radius: 7px; cursor: pointer; display: flex; align-items: center; gap: 8px; }
  ul.list li:hover { background: #1f2430; }
  ul.list li.on { background: #253049; }
  ul.list li .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  ul.list li .tag { font-size: 11px; color: var(--dim); border: 1px solid var(--line); border-radius: 4px; padding: 0 4px; }
  .edit-pane { flex: 1; overflow: auto; padding: 16px 20px; }
  .empty { color: var(--dim); padding: 40px 10px; text-align: center; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; font-size: 12px; color: var(--dim); margin-bottom: 4px; }
  .row { display: flex; gap: 10px; align-items: center; margin-top: 16px; }
  .row .grow { flex: 1; color: var(--dim); font-size: 12px; }
  #toast { position: fixed; right: 18px; bottom: 18px; background: #23303f; border: 1px solid #35506b; color: #d6e6ff; padding: 10px 16px; border-radius: 8px; opacity: 0; transform: translateY(8px); transition: .18s; pointer-events: none; max-width: 420px; }
  #toast.on { opacity: 1; transform: none; }
  #toast.bad { border-color: #6b3535; color: #ffd6d6; background: #2f2222; }
</style>
</head>
<body>
<header>
  <h1>陪玩搭子-三国杀 · 数据库 <small id="meta">加载中…</small></h1>
  <div class="tabs">
    <button data-tab="generals" class="on">武将库 <span class="count" id="gcount"></span></button>
    <button data-tab="slang">黑话库 <span class="count" id="scount"></span></button>
    <button data-tab="harvest">采集 <span class="count" id="hcount"></span></button>
  </div>
</header>
<main>
  <section class="list-pane" id="list-pane">
    <div class="toolbar">
      <input type="search" id="q" placeholder="搜名字 / 技能 / 别称…">
      <button class="btn" id="new">新建</button>
    </div>
    <ul class="list" id="list"></ul>
  </section>
  <section class="edit-pane" id="edit"><div class="empty">左边选一条，或者点「新建」。</div></section>
  <section class="edit-pane" id="harvest-pane" style="display:none"></section>
</main>
<div id="toast"></div>
<script>
(function () {
  var state = { tab: 'generals', items: [], selected: null, q: '', kinds: [] };
  var $ = function (id) { return document.getElementById(id); };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function toast(msg, bad) {
    var el = $('toast');
    el.textContent = msg;
    el.className = bad ? 'on bad' : 'on';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { el.className = ''; }, 2600);
  }
  function api(method, url, body) {
    return fetch(url, body === undefined
      ? { method: method }
      : { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    ).then(function (r) { return r.json().then(function (j) { if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  function kindLabel(kind) {
    for (var i = 0; i < state.kinds.length; i++) if (state.kinds[i].kind === kind) return state.kinds[i].label;
    return kind;
  }

  function loadMeta() {
    return api('GET', '/api/meta').then(function (meta) {
      state.kinds = meta.kinds || [];
      $('meta').textContent = '武将 ' + meta.generals + ' 条（内置 ' + meta.generalsBuiltin + '） · 黑话 ' + meta.slang + ' 条（内置 ' + meta.slangBuiltin + '）';
      $('gcount').textContent = '(' + meta.generals + ')';
      $('scount').textContent = '(' + meta.slang + ')';
    });
  }

  function loadItems() {
    var url = state.tab === 'generals' ? '/api/generals' : '/api/slang';
    return api('GET', url).then(function (data) {
      state.items = data.items || [];
      renderList();
      applyHash();
    });
  }

  // #generals/姜维 这种锚点可以直接打开某一条，方便把链接发给别人
  function applyHash() {
    var raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    var cut = raw.indexOf('/');
    if (cut < 0) return;
    var tab = raw.slice(0, cut);
    var name = decodeURIComponent(raw.slice(cut + 1));
    if (tab !== state.tab || !name) return;
    var hit = state.items.filter(function (it) {
      if (state.tab === 'generals') return it.name === name || (it.alias || []).indexOf(name) >= 0;
      return it.term === name || (it.aliases || []).indexOf(name) >= 0;
    })[0];
    if (hit && state.selected !== hit) {
      state.selected = hit;
      renderList();
      renderEditor();
    }
  }

  window.addEventListener('hashchange', applyHash);

  function matches(item) {
    if (!state.q) return true;
    var q = state.q.toLowerCase();
    if (state.tab === 'generals') {
      var hay = [item.name, item.kingdom || '', (item.skills || []).map(function (s) { return s.name + s.text; }).join(''), item.play || '', (item.alias || []).join('')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    }
    var hay2 = [item.term, item.meaning, item.note || '', (item.aliases || []).join(''), (item.generals || []).join('')].join(' ').toLowerCase();
    return hay2.indexOf(q) >= 0;
  }

  function renderList() {
    var list = $('list');
    list.innerHTML = '';
    var shown = state.items.filter(matches);
    if (shown.length === 0) {
      var li = document.createElement('li');
      li.className = 'empty';
      li.textContent = state.q ? '没有匹配的条目' : '还没有条目';
      list.appendChild(li);
      return;
    }
    shown.forEach(function (item) {
      var li = document.createElement('li');
      var name = state.tab === 'generals' ? item.name : item.term;
      var tag = state.tab === 'generals'
        ? (item.kingdom || '?') + (item.hp ? item.hp : '')
        : kindLabel(item.kind);
      li.innerHTML = '<span class="nm">' + esc(name) + '</span><span class="tag">' + esc(tag) + '</span>';
      if (state.selected !== null && ((state.tab === 'generals' && state.selected.name === name) || (state.tab === 'slang' && state.selected.term === name))) li.className = 'on';
      li.onclick = function () { state.selected = item; renderList(); renderEditor(); location.hash = state.tab + '/' + encodeURIComponent(name); };
      list.appendChild(li);
    });
  }

  function field(label, inner) {
    return '<div class="field"><label>' + esc(label) + '</label>' + inner + '</div>';
  }

  function renderEditor() {
    var pane = $('edit');
    if (state.tab === 'generals') {
      var g = state.selected;
      var skillsText = (g.skills || []).map(function (s) { return s.name + '｜' + s.text; }).join('\\n');
      pane.innerHTML =
        '<div class="grid">' +
        field('武将名', '<input type="text" id="f-name" value="' + esc(g.name) + '">') +
        field('势力', '<select id="f-kingdom">' + ['魏','蜀','吴','群','神','OL',''].map(function (k) {
          return '<option value="' + k + '"' + (g.kingdom === k ? ' selected' : '') + '>' + (k || '（不填）') + '</option>';
        }).join('') + '</select>') +
        '</div>' +
        '<div class="grid">' +
        field('体力上限', '<input type="number" id="f-hp" min="1" max="10" value="' + (g.hp || '') + '">') +
        field('来源（只读）', '<input type="text" value="' + esc(g.source || '') + '" disabled>') +
        '</div>' +
        field('技能（每行一条：技能名｜技能描述）', '<textarea id="f-skills" style="min-height:140px">' + esc(skillsText) + '</textarea>') +
        field('打法（一句话）', '<textarea id="f-play">' + esc(g.play || '') + '</textarea>') +
        field('克制 / 被克制', '<textarea id="f-counter">' + esc(g.counter || '') + '</textarea>') +
        '<div class="row"><button class="btn primary" id="save">保存</button>' +
        '<button class="btn danger" id="del">删除</button>' +
        '<span class="grow">保存后立刻生效，宠物下次查这名武将就是新内容。</span></div>';
    } else {
      var s = state.selected;
      var opts = state.kinds.map(function (k) {
        return '<option value="' + k.kind + '"' + (s.kind === k.kind ? ' selected' : '') + '>' + esc(k.label) + '</option>';
      }).join('');
      pane.innerHTML =
        '<div class="grid">' +
        field('词条', '<input type="text" id="f-term" value="' + esc(s.term) + '">') +
        field('类型', '<select id="f-kind">' + opts + '</select>') +
        '</div>' +
        '<div class="grid">' +
        field('别名（逗号分隔）', '<input type="text" id="f-aliases" value="' + esc((s.aliases || []).join('、')) + '">') +
        field('关联武将（逗号分隔）', '<input type="text" id="f-generals" value="' + esc((s.generals || []).join('、')) + '">') +
        '</div>' +
        field('释义', '<textarea id="f-meaning">' + esc(s.meaning) + '</textarea>') +
        field('备注 / 出处', '<textarea id="f-note">' + esc(s.note || '') + '</textarea>') +
        field('来源（只读）', '<input type="text" value="' + esc(s.source || '') + '" disabled>') +
        '<div class="row"><button class="btn primary" id="save">保存</button>' +
        '<button class="btn danger" id="del">删除</button>' +
        '<span class="grow">宠物聊天时会参考这里的说法；别称也能用来查到对应武将。</span></div>';
    }

    $('save').onclick = save;
    $('del').onclick = remove;
  }

  function parseSkillLines(text) {
    var out = [];
    String(text || '').split(/\\r?\\n/).forEach(function (line) {
      var t = line.trim();
      if (!t) return;
      var idx = t.indexOf('｜') >= 0 ? t.indexOf('｜') : (t.indexOf('|') >= 0 ? t.indexOf('|') : t.indexOf('：'));
      if (idx > 0) out.push({ name: t.slice(0, idx).trim(), text: t.slice(idx + 1).trim() });
      else out.push({ name: '技能', text: t });
    });
    return out.filter(function (s) { return s.name && s.text; });
  }

  function save() {
    if (!state.selected) return;
    var isNew = !!state.selected.__new;
    if (state.tab === 'generals') {
      var skills = parseSkillLines($('f-skills').value);
      if (!$('f-name').value.trim()) return toast('武将名不能为空', true);
      if (skills.length === 0) return toast('至少要写一条技能', true);
      api('POST', '/api/generals', {
        name: $('f-name').value.trim(), kingdom: $('f-kingdom').value, hp: Number($('f-hp').value) || undefined,
        skills: skills, play: $('f-play').value, counter: $('f-counter').value
      }).then(function (r) {
        toast((isNew ? '已新增 ' : '已保存 ') + r.item.name);
        return refresh(r.item.name);
      }).catch(function (e) { toast(e.message, true); });
    } else {
      if (!$('f-term').value.trim()) return toast('词条不能为空', true);
      if (!$('f-meaning').value.trim()) return toast('释义不能为空', true);
      api('POST', '/api/slang', {
        term: $('f-term').value.trim(), kind: $('f-kind').value, aliases: $('f-aliases').value,
        generals: $('f-generals').value, meaning: $('f-meaning').value, note: $('f-note').value
      }).then(function (r) {
        toast((isNew ? '已新增 ' : '已保存 ') + r.item.term);
        return refresh(r.item.term);
      }).catch(function (e) { toast(e.message, true); });
    }
  }

  function refresh(name) {
    return loadMeta().then(loadItems).then(function () {
      var hit = state.items.filter(function (it) { return (state.tab === 'generals' ? it.name : it.term) === name; })[0];
      state.selected = hit || null;
      renderList();
      if (state.selected) renderEditor();
    });
  }

  function remove() {
    if (!state.selected || state.selected.__new) return;
    var name = state.tab === 'generals' ? state.selected.name : state.selected.term;
    if (!confirm('确定删除「' + name + '」？\\n（内置条目删不掉，只能改成覆盖版）')) return;
    var url = state.tab === 'generals' ? '/api/generals?name=' + encodeURIComponent(name) : '/api/slang?term=' + encodeURIComponent(name);
    api('DELETE', url).then(function (r) {
      toast('已删除 ' + name);
      state.selected = null;
      $('edit').innerHTML = '<div class="empty">已删除，左边再选一条。</div>';
      return loadMeta().then(loadItems);
    }).catch(function (e) { toast(e.message, true); });
  }

  function loadHarvest() {
    var pane = $('harvest-pane');
    return api('GET', '/api/harvest').then(function (data) {
      if (data.ok === false) {
        pane.innerHTML = '<div class="empty">' + esc(data.error || '采集没有开') + '</div>';
        $('hcount').textContent = '';
        return;
      }
      state.harvest = data;
      renderHarvest();
    }).catch(function (e) {
      pane.innerHTML = '<div class="empty">读取失败：' + esc(e.message) + '</div>';
    });
  }

  function row(inner) {
    return '<div style="display:flex;gap:10px;align-items:center;padding:8px 10px;border-bottom:1px solid var(--line)">' + inner + '</div>';
  }
  function btn(label, attr, value, primary) {
    return '<button class="btn" ' + attr + '="' + esc(value) + '"' + (primary ? '' : ' style="background:transparent;border:1px solid var(--line);color:var(--dim)"') + '>' + esc(label) + '</button>';
  }

  function renderHarvest() {
    var d = state.harvest;
    if (!d) return;
    var s = d.stats;
    $('hcount').textContent = '(' + s.candidates + ')';
    var h = [];
    h.push('<div style="display:flex;gap:18px;flex-wrap:wrap;padding:10px 14px;color:var(--dim);font-size:12px;border-bottom:1px solid var(--line)">' +
      '<span>对局武将 ' + s.generals + ' 位</span><span>黑话候选 ' + s.candidates + ' 条</span>' +
      '<span>最近弹幕 ' + s.danmaku + ' 条</span><span>直播场次 ' + s.sessions + ' 场</span></div>');

    h.push('<div style="padding:14px 14px 4px;color:var(--fg);font-size:13px">对局里遇到的武将 <span style="color:var(--dim)">（还没入库的可以点「联网补库」）</span></div>');
    if (d.generals.length === 0) h.push('<div class="empty">还没记到武将。开局读一次画面就会自动记。</div>');
    d.generals.forEach(function (g) {
      h.push(row(
        '<span style="min-width:120px">' + esc(g.name) + '</span>' +
        '<span class="tag">' + esc(g.via === 'screen' ? '画面' : '弹幕') + '</span>' +
        '<span style="color:var(--dim);font-size:12px">见过 ' + g.count + ' 次</span>' +
        '<span style="flex:1"></span>' +
        (g.learned
          ? '<span style="color:#6fbf8f;font-size:12px">已入库</span>'
          : btn('联网补库', 'data-learn', g.name))));
    });

    h.push('<div style="padding:14px 14px 4px;color:var(--fg);font-size:13px">弹幕里冒出来的新说法 <span style="color:var(--dim)">（点「入库」才写进黑话库，释义之后记得补）</span></div>');
    if (d.candidates.length === 0) h.push('<div class="empty">暂时没有候选。直播时弹幕里说到的词会攒在这里。</div>');
    d.candidates.forEach(function (c) {
      h.push(row(
        '<span style="min-width:120px">' + esc(c.term) + '</span>' +
        '<span class="tag">' + c.count + ' 次</span>' +
        '<span style="flex:1;color:var(--dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc((c.samples || []).join(' / ')) + '</span>' +
        btn('入库', 'data-accept', c.term, true) +
        btn('忽略', 'data-ignore', c.term)));
    });

    if (d.recent && d.recent.length > 0) {
      h.push('<div style="padding:14px 14px 4px;color:var(--fg);font-size:13px">最近的弹幕</div>');
      d.recent.slice(0, 12).forEach(function (r) {
        h.push(row('<span style="color:var(--dim);font-size:12px;min-width:90px">' + esc(r.user || '观众') + '</span><span style="font-size:13px">' + esc(r.text) + '</span>'));
      });
    }

    var pane = $('harvest-pane');
    pane.innerHTML = h.join('');
    Array.prototype.forEach.call(pane.querySelectorAll('[data-accept]'), function (b) {
      b.onclick = function () {
        api('POST', '/api/harvest/accept', { term: b.getAttribute('data-accept') })
          .then(function (r) { toast('已入库 ' + r.item.term + '，记得补一句释义'); return loadMeta().then(loadHarvest); })
          .catch(function (e) { toast(e.message, true); });
      };
    });
    Array.prototype.forEach.call(pane.querySelectorAll('[data-ignore]'), function (b) {
      b.onclick = function () {
        api('POST', '/api/harvest/ignore', { term: b.getAttribute('data-ignore') })
          .then(loadHarvest)
          .catch(function (e) { toast(e.message, true); });
      };
    });
    Array.prototype.forEach.call(pane.querySelectorAll('[data-learn]'), function (b) {
      b.onclick = function () {
        var name = b.getAttribute('data-learn');
        b.textContent = '查…';
        api('POST', '/api/harvest/learn', { name: name })
          .then(function (r) { toast('已补库：' + r.item.name); return loadMeta().then(loadHarvest); })
          .catch(function (e) { b.textContent = '联网补库'; toast(e.message, true); });
      };
    });
  }

  function paintTabs(tab) {
    Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
      b.className = b.getAttribute('data-tab') === tab ? 'on' : '';
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    state.selected = null;
    state.q = $('q').value = '';
    paintTabs(tab);
    var isHarvest = tab === 'harvest';
    $('list-pane').style.display = isHarvest ? 'none' : '';
    $('edit').style.display = isHarvest ? 'none' : '';
    $('harvest-pane').style.display = isHarvest ? '' : 'none';
    if (isHarvest) {
      loadHarvest();
      return;
    }
    $('edit').innerHTML = '<div class="empty">左边选一条，或者点「新建」。</div>';
    loadItems();
  }

  function newItem() {
    state.selected = state.tab === 'generals'
      ? { __new: true, name: '', kingdom: '蜀', hp: 3, skills: [], play: '', counter: '', source: 'editor' }
      : { __new: true, term: '', kind: 'jargon', aliases: [], generals: [], meaning: '', note: '', source: 'editor' };
    renderList();
    renderEditor();
    var first = state.tab === 'generals' ? $('f-name') : $('f-term');
    if (first) first.focus();
  }

  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'), function (b) {
    b.onclick = function () { switchTab(b.getAttribute('data-tab')); };
  });
  $('new').onclick = newItem;
  $('q').oninput = function () { state.q = this.value.trim(); renderList(); };

  loadMeta().then(function () {
    var raw = location.hash.replace(/^#/, '');
    var cut = raw.indexOf('/');
    var tab = cut > 0 ? raw.slice(0, cut) : (raw === 'harvest' ? 'harvest' : '');
    if (tab === 'slang' || tab === 'generals' || tab === 'harvest') { state.tab = tab; paintTabs(tab); }
    if (tab === 'harvest') {
      $('list-pane').style.display = 'none';
      $('edit').style.display = 'none';
      $('harvest-pane').style.display = '';
      loadHarvest();
      return;
    }
    return loadItems();
  });
})();
</script>
</body>
</html>`;
