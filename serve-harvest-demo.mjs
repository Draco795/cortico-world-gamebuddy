/** 起一个带采集数据的编辑器（常驻，供外部截图）。Ctrl+C / kill 结束。 */
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
  ['路人己', '这波双开直接赢'],
  ['路人庚', '双开双开，稳了'],
  ['路人辛', '摸牌白也想赢？'],
  ['路人壬', '摸牌白经典操作'],
  ['路人癸', '铁索连环连起来'],
]) harvest.noteDanmaku(text, user);
harvest.noteGeneral('简雍', 'screen');
harvest.noteGeneral('姜维', 'screen');
harvest.noteGeneral('谋华雄', 'chat');
harvest.save(true);
console.log('stats', JSON.stringify(harvest.stats()), '|', harvest.candidates(10).map((c) => c.term + '×' + c.count).join(' '));

const editor = await startEditor({
  port: 17792,
  generals: book,
  slang,
  harvest,
  learnGeneral: async () => null,
  log: { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m) },
});
console.log('READY', editor.url);
setInterval(() => {}, 60_000);
