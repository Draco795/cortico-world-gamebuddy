/** 验证画面预读缓存：第一帧现场读，第二帧应当直接命中缓存。 */
import { GameBuddyWorld } from './src/world.ts';
import { GAMEBUDDY_DEFAULTS } from './src/config.ts';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './dev.mjs';

const dataDir = join(ROOT, '.tmp-refresh');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const cfg = {
  ...GAMEBUDDY_DEFAULTS,
  windowPattern: 'Cortico',
  refreshSec: 0, // 先关掉后台预读，单看缓存
  sendImage: false,
  harvest: false,
  editor: false,
};

const world = new GameBuddyWorld({
  cfg,
  dataDir,
  packageDir: '.',
  live: () => cfg,
  persist: () => {},
});

const host = {
  log: { info: (m) => console.log('[log]', m), warn: (m) => console.log('[warn]', m), error: (m) => console.log('[err]', m) },
  store: { latestCursor: () => 0, range: async () => ({ events: [], nextCursor: 0 }) },
  pushEvent: async () => {},
};
world.host = host;
world.armed = true;

let t = Date.now();
const first = await world.lookText(true, false);
console.log('first look', Date.now() - t + 'ms');
console.log('  head:', String(typeof first === 'string' ? first : first.text).split('\n')[0]);

t = Date.now();
const second = await world.lookText(true, false);
console.log('second(force) look', Date.now() - t + 'ms');

t = Date.now();
const third = await world.lookText(false, false);
console.log('third(cached) look', Date.now() - t + 'ms');
console.log('  head:', String(typeof third === 'string' ? third : third.text).split('\n')[0]);

console.log('env state:', world.envPromptVars()['gamebuddy.state'].split('\n').slice(-1)[0]);

// 后台预读：手动调一次 preload（需要 focused）
world.focused = true;
world.windows = [];
t = Date.now();
await world.preload();
console.log('preload', Date.now() - t + 'ms');
t = Date.now();
await world.lookText(false, false);
console.log('after preload, cached look', Date.now() - t + 'ms');
