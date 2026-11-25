/** 联网补一个武将进真实数据目录。用法: node add-general.mjs 神郭嘉 */
import { join } from 'node:path';
import { GeneralBook } from './src/generals.ts';
import { fetchGeneral } from './src/wiki.ts';
import { DATA_DIR } from './dev.mjs';

const name = process.argv[2] ?? '神郭嘉';
const dataDir = DATA_DIR;
const book = new GeneralBook(join(root, 'data/generals.json'), join(dataDir, 'generals-user.json'));

const before = book.lookup(name);
console.log('before:', before ? before.name : '(miss)');
const t0 = Date.now();
const got = await fetchGeneral(name, 12000);
console.log('fetch', Date.now() - t0 + 'ms', got ? `${got.name} ${got.kingdom} ${got.hp}血 ${got.skills.map((s) => s.name).join('/')} <- ${got.source}` : 'FAIL');
if (got) {
  book.teach({ ...got, source: got.source ?? 'web' });
  const after = book.lookup(name);
  console.log('after:', after ? `${after.name} ${after.kingdom} ${after.hp}血 ${after.skills.map((s) => s.name).join('/')}` : '(miss)');
  console.log('total:', book.size);
}
