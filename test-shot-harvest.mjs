/** 起一个带采集数据的编辑器，用无头 Edge 截「采集」页。 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Harvest } from './src/harvest.ts';
import { GeneralBook } from './src/generals.ts';
import { SlangBook } from './src/slang.ts';
import { startEditor } from './src/editor.ts';
import { ROOT as root } from './dev.mjs';

const tmp = join(root, '.tmp-harvest-shot');
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

for (const [user, text] of [
  ['路人甲', '狗货又来了，这把稳了'],
  ['路人乙', '乐不思蜀贴他脸上'],
  ['路人丙', '翻盘点来了兄弟'],
  ['路人丁', '翻盘点翻盘点'],
  ['路人戊', '谋华雄也能玩？'],
  ['路人己', '铁索连环连起来'],
]) harvest.noteDanmaku(text, user);
harvest.noteGeneral('简雍', 'screen');
harvest.noteGeneral('姜维', 'screen');
harvest.noteGeneral('谋华雄', 'chat');
harvest.save(true);
console.log('stats', JSON.stringify(harvest.stats()), harvest.candidates(10).map((c) => c.term + '×' + c.count).join(' '));

const editor = await startEditor({
  port: 17792,
  generals: book,
  slang,
  harvest,
  learnGeneral: async () => null,
  log: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
});

const edge = process.env.EDGE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const shot = join(root, 'shot-harvest.png');
const res = spawnSync(edge, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars',
  '--user-data-dir=' + join(tmp, 'edge'),
  '--window-size=1280,900', '--virtual-time-budget=6000',
  '--screenshot=' + shot,
  editor.url + '#harvest',
], { encoding: 'utf8' });
console.log('edge exit', res.status, (res.stderr || '').split('\n').filter((l) => l.includes('ERROR')).slice(0, 2).join(' | '));
await editor.close();
