/** 验证两个库的采集开关：面板能读写、写回配置、关掉后采集真的停。 */
import { GameBuddyWorld } from './src/world.ts';
import { GAMEBUDDY_DEFAULTS } from './src/config.ts';
import { Harvest } from './src/harvest.ts';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dev.mjs';

const dataDir = join(ROOT, '.tmp-collect');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const cfg = {
  ...GAMEBUDDY_DEFAULTS,
  harvest: true,
  editor: false,
  refreshSec: 0,
  pollSec: 0,
};
const persisted = [];
const world = new GameBuddyWorld({
  cfg,
  dataDir,
  packageDir: '.',
  live: () => cfg,
  persist: (patch) => {
    persisted.push(patch);
    Object.assign(cfg, patch);
  },
});
world.host = {
  log: { info: () => {}, warn: () => {}, error: () => {} },
  store: { latestCursor: () => 0, range: async () => ({ events: [], nextCursor: 0 }) },
  pushEvent: async () => {},
};
world.armed = true;

const panel = world.webUi('zh').panels[0].id;
const inv = (method, args) => world.webUi('zh').invoke(panel, method, args);

console.log('初始 state:', JSON.stringify(await inv('state')).slice(0, 160));
console.log('collect:', JSON.stringify(await inv('collect')));

console.log('--- 关掉武将库采集 ---');
console.log('setCollect:', JSON.stringify(await inv('setCollect', ['generals', false])));
console.log('persist 记录:', JSON.stringify(persisted));

const st = await inv('state');
console.log('state.collectGenerals =', st.collectGenerals, ' state.collectSlang =', st.collectSlang);
const status = await inv('status');
console.log('status 里有库采集行:', status.split('\n').filter((l) => l.includes('库采集')).join(' | '));

console.log('--- 再关掉黑话库采集 ---');
await inv('setCollect', ['slang', false]);
console.log('status:', (await inv('status')).split('\n').filter((l) => l.includes('库采集')).join(' | '));

try {
  await inv('setCollect', ['nope', true]);
} catch (error) {
  console.log('坏参数报错:', error.message);
}

console.log('--- 两个都关时，弹幕不该再攒候选 ---');
const harvest = new Harvest(`${dataDir}/harvest.json`, {
  knownSlang: (term) => term === '乐不思蜀',
  detectSlang: (text) => (text.includes('乐') ? ['乐不思蜀'] : []),
  detectGenerals: (text) => (text.includes('姜维') ? ['姜维'] : []),
  knownGeneral: (name) => name === '姜维',
});
const before = harvest.stats();
harvest.noteDanmaku('乐不思蜀贴他脸上，姜维这波翻盘点', '路人甲', { slang: false, generals: false });
const after = harvest.stats();
console.log('全关 noteDanmaku:', JSON.stringify(before), '→', JSON.stringify(after));

harvest.noteDanmaku('乐不思蜀贴他脸上，姜维这波翻盘点', '路人甲', { slang: true, generals: false });
const onlySlang = harvest.stats();
console.log('只开黑话:', JSON.stringify(onlySlang), '武将=', JSON.stringify(harvest.generalHits(10).map((h) => h.name)));

harvest.noteDanmaku('姜维这波翻盘点', '路人乙', { slang: false, generals: true });
console.log('只开武将:', JSON.stringify(harvest.stats()), '武将=', JSON.stringify(harvest.generalHits(10).map((h) => [h.name, h.count])));
