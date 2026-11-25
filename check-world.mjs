import { GameBuddyWorld } from './src/world.ts';
const proto = GameBuddyWorld.prototype;
const methods = ['slangText', 'slangTeachText', 'teachText', 'harvestText', 'statusText'];
for (const m of methods) console.log(m, typeof proto[m]);
const tools = proto['tools'];
console.log('load ok');
