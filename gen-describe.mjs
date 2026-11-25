/** 从 definition.ts 重新生成 describe.json（改了工具/事件就跑一次）。 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAMEBUDDY } from './src/definition.ts';
import { ROOT } from './dev.mjs';

const out = join(ROOT, 'describe.json');
writeFileSync(out, JSON.stringify(GAMEBUDDY.describe, null, 2) + '\n', 'utf8');
console.log('tools:', GAMEBUDDY.describe.tools.map((t) => t.name).join(', '));
console.log('events:', GAMEBUDDY.describe.events.map((e) => e.type).join(', '));
