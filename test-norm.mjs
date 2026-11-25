import { join } from 'node:path';
import { GeneralBook } from './src/generals.ts';
import { ROOT as root, DATA_DIR } from './dev.mjs';

const book = new GeneralBook(join(root, 'data/generals.json'), join(DATA_DIR, 'generals-user.json'));
console.log('size', book.size, 'builtin', book.builtinSize);
for (const q of ['郭嘉', '神郭嘉', '界姜维', '姜维', '界简雍', '简雍', '神吕蒙', '吕蒙']) {
  const g = book.lookup(q);
  console.log(q.padEnd(5), '→', g ? `${g.name} ${g.kingdom}${g.hp}血 ${g.skills.map((s) => s.name).join('/')}` : '(miss)');
}
console.log('detect:', book.detect('界姜维 神郭嘉 郭嘉 简雍').map((g) => g.name).join(' / '));
