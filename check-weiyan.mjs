import { join } from "node:path";
import { GeneralBook } from "./src/generals.ts";
import { ROOT as root, DATA_DIR } from "./dev.mjs";
const b = new GeneralBook(join(root, "data/generals.json"), join(DATA_DIR, "generals-user.json"));
for (const q of ["势魏延", "魏延", "星魏延", "界魏延"]) {
  const g = b.lookup(q);
  console.log("---", q, "->", g ? g.name : "(miss)");
  if (g) console.log(b.format(g));
}
