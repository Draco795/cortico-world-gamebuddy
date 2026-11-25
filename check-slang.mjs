import { join } from "node:path";
import { SlangBook } from "./src/slang.ts";
import { ROOT as root, DATA_DIR } from "./dev.mjs";
const b = new SlangBook(join(root, "data/slang.json"), join(DATA_DIR, "slang-user.json"));
console.log("size", b.size);
for (const q of ["二锅头", "二郭头", "牛栏三", "威四忌", "五粮液", "狗货"]) {
  const r = b.lookup(q);
  console.log(q, "->", r ? r.term + " | " + r.meaning : "(miss)");
}
console.log("detect:", b.detect("他又二锅头了，昨天还五粮液").map(e => e.term).join(" / "));
