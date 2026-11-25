/** 直播采集冒烟测试：攒数据 → 编辑器读 → 入库/忽略/补库 → 落盘。 */
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Harvest } from './src/harvest.ts';
import { GeneralBook } from './src/generals.ts';
import { SlangBook } from './src/slang.ts';
import { startEditor } from './src/editor.ts';
import { ROOT as root } from './dev.mjs';

const tmp = join(root, '.tmp-harvest');
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const book = new GeneralBook(join(root, 'data/generals.json'), join(tmp, 'generals-user.json'));
const slang = new SlangBook(join(root, 'data/slang.json'), join(tmp, 'slang-user.json'));
const harvest = new Harvest(join(tmp, 'harvest.json'), {
  knownSlang: (t) => Boolean(slang.get(t)),
  detectSlang: (t) => slang.detect(t).map((e) => e.term),
  detectGenerals: (t) => book.detect(t).map((g) => g.name),
  knownGeneral: (n) => Boolean(book.lookup(n)),
});

console.log('books:', book.size, slang.size);

// 模拟几条弹幕
const lines = [
  ['观众A', '狗货又来了，这把稳了'],
  ['观众B', '乐不思蜀贴他脸上'],
  ['观众C', '这波得苟住，别跳反'],
  ['观众D', '翻盘点来了兄弟'],
  ['观众E', '翻盘点翻盘点'],
  ['观众F', '谋华雄也能玩？'],
  ['观众G', '铁索连环连起来'],
  ['观众H', '铁索连环又来了'],
];
for (const [user, text] of lines) harvest.noteDanmaku(text, user);
// 模拟读屏认出武将
harvest.noteGeneral('简雍', 'screen');
harvest.noteGeneral('姜维', 'screen');
harvest.beginSession();
harvest.save(true);

console.log('stats:', JSON.stringify(harvest.stats()));
console.log('candidates:', harvest.candidates(10).map((c) => `${c.term}×${c.count}`).join(' '));
console.log('generalHits:', harvest.generalHits(10).map((g) => `${g.name}×${g.count} learned=${g.learned}`).join(' '));

const editor = await startEditor({
  port: 17791,
  generals: book,
  slang,
  harvest,
  learnGeneral: async (name) => book.teach({ name, kingdom: '群', hp: 4, skills: [{ name: '测试技', text: '假技能' }], source: 'test' }),
  log: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
});
console.log('editor:', editor.url);

const get = async (p) => (await fetch(editor.url.replace(/\/$/, '') + p)).json();
const post = async (p, body) => {
  const r = await fetch(editor.url.replace(/\/$/, '') + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
};

const h1 = await get('/api/harvest');
console.log('GET /api/harvest ok=', h1.ok, 'stats=', JSON.stringify(h1.stats));

const acc = await post('/api/harvest/accept', { term: h1.candidates[0].term });
console.log('accept:', acc.ok, acc.item?.term, 'slang now', acc.total);
const ign = h1.candidates[1] ? await post('/api/harvest/ignore', { term: h1.candidates[1].term }) : { ok: 'skipped' };
console.log('ignore:', ign.ok);
const learn = await post('/api/harvest/learn', { name: '谋华雄' });
console.log('learn:', learn.ok, learn.item?.name, learn.error ?? '');

const h2 = await get('/api/harvest');
console.log('after: candidates=', h2.candidates.map((c) => c.term).join(' '), '| generals=', h2.generals.map((g) => `${g.name}:${g.learned}`).join(' '));

const html = await (await fetch(editor.url)).text();
console.log('page has harvest tab:', html.includes('data-tab="harvest"'), 'size=', html.length);

console.log('files:', ['harvest.json', 'slang-user.json', 'generals-user.json'].map((f) => `${f}:${existsSync(join(tmp, f))}`).join(' '));
console.log('slang-user head:', readFileSync(join(tmp, 'slang-user.json'), 'utf8').slice(0, 120).replace(/\s+/g, ' '));
await editor.close();
