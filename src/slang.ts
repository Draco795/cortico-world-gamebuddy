/**
 * 本地黑话库：武将别称、常见梗、术语和牌的简称。
 *
 * 和武将库一样是两层：内置库（随包分发 data/slang.json）+ 用户库
 * （dataDir/slang-user.json，由编辑器页面、gamebuddy_slang 的 teach 动作写入）。
 * 用户库同名条目覆盖内置条目。
 *
 * 为什么单独一个库：武将技能是"事实"，黑话是"说话方式"。混在一起会让
 * detect 把「乐」「狮子」这类简称当成武将名，查技能时就串味了。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type SlangKind = 'nickname' | 'meme' | 'jargon' | 'card';

export interface SlangEntry {
  /** 主词条：黑话本身，例如「乐」「狗货」。 */
  term: string;
  kind: SlangKind;
  /** 别的写法，如「乐不」「乐牌」。 */
  aliases?: string[];
  /** 这条黑话指涉的武将（用于从黑话跳到武将库）。 */
  generals?: string[];
  /** 一句话解释。 */
  meaning: string;
  /** 出处、用法、注意事项。 */
  note?: string;
  source?: string;
}

interface BookFile {
  version?: number;
  slang?: SlangEntry[];
}

export const KIND_LABEL: Record<SlangKind, string> = {
  nickname: '武将别称',
  meme: '梗',
  jargon: '术语',
  card: '牌/装备',
};

/** 统一写法：去空白、去引号、拉丁字母小写。 */
export function normalizeTerm(raw: string): string {
  return raw
    .replace(/[\s"'“”「」『』【】]/gu, '')
    .trim()
    .toLowerCase();
}

function loadFile(path: string): SlangEntry[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BookFile | SlangEntry[];
    const list = Array.isArray(parsed) ? parsed : parsed.slang ?? [];
    return list.filter((e) => e && typeof e.term === 'string' && typeof e.meaning === 'string');
  } catch {
    return [];
  }
}

export class SlangBook {
  private readonly byTerm = new Map<string, SlangEntry>();
  private readonly userPath: string;
  private readonly builtinPath: string;
  private userEntries: SlangEntry[] = [];
  private builtinCount = 0;

  constructor(builtinPath: string, userPath: string) {
    this.builtinPath = builtinPath;
    this.userPath = userPath;
    this.reload();
  }

  reload(): void {
    this.byTerm.clear();
    const builtin = loadFile(this.builtinPath);
    this.userEntries = loadFile(this.userPath);
    this.builtinCount = builtin.length;
    for (const entry of [...builtin, ...this.userEntries]) {
      const clean: SlangEntry = {
        ...entry,
        source: entry.source ?? (this.userEntries.includes(entry) ? 'user' : 'builtin'),
      };
      for (const key of [entry.term, ...(entry.aliases ?? [])]) {
        const norm = normalizeTerm(key);
        if (norm) this.byTerm.set(norm, clean);
      }
    }
  }

  /** 词条数（含别名，按唯一词条去重）。 */
  get size(): number {
    return new Set([...this.byTerm.values()].map((e) => normalizeTerm(e.term))).size;
  }

  get builtinSize(): number {
    return this.builtinCount;
  }

  /** 全部条目（按 kind 分组，供编辑器展示）。 */
  list(): SlangEntry[] {
    const seen = new Set<string>();
    const out: SlangEntry[] = [];
    for (const entry of this.byTerm.values()) {
      const key = normalizeTerm(entry.term);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out.sort((a, b) => a.term.localeCompare(b.term, 'zh'));
  }

  get(term: string): SlangEntry | null {
    return this.byTerm.get(normalizeTerm(term)) ?? null;
  }

  /** 精确 → 别名 → 包含；给用户输入的脏词留点余地。 */
  lookup(raw: string): SlangEntry | null {
    const key = normalizeTerm(raw);
    if (!key) return null;
    const direct = this.byTerm.get(key);
    if (direct) return direct;
    for (const [term, entry] of this.byTerm) {
      if (term.length >= 2 && (key.includes(term) || term.includes(key))) return entry;
    }
    return null;
  }

  /** 在一段话里找出出现过的黑话（长词优先，单字别名不参与，避免噪声）。 */
  detect(text: string, limit = 6): SlangEntry[] {
    const flat = normalizeTerm(text);
    if (!flat) return [];
    const keys = [...this.byTerm.keys()].filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
    const hits: SlangEntry[] = [];
    const seen = new Set<string>();
    for (const key of keys) {
      if (!flat.includes(key)) continue;
      const entry = this.byTerm.get(key)!;
      const id = normalizeTerm(entry.term);
      if (seen.has(id)) continue;
      seen.add(id);
      hits.push(entry);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** 给模型看的一段词条。 */
  format(entry: SlangEntry): string {
    const head = `【${entry.term}】${KIND_LABEL[entry.kind] ?? entry.kind}${entry.generals?.length ? ` · 指 ${entry.generals.join('、')}` : ''}`;
    const aliases = entry.aliases?.length ? `又叫：${entry.aliases.join('、')}` : '';
    return [head, entry.meaning, entry.note ? `备注：${entry.note}` : '', aliases].filter((line) => line !== '').join('\n');
  }

  /** 环境提示词里的一句话版。 */
  brief(entry: SlangEntry): string {
    return `${entry.term}=${entry.meaning}${entry.generals?.length ? `（指${entry.generals.join('、')}）` : ''}`;
  }

  /** 写入用户库；同名词条覆盖。 */
  teach(entry: SlangEntry): SlangEntry {
    const clean: SlangEntry = {
      term: entry.term.replace(/\s+/g, '').trim(),
      kind: entry.kind,
      aliases: (entry.aliases ?? []).map((a) => a.trim()).filter((a) => a !== ''),
      generals: (entry.generals ?? []).map((g) => g.trim()).filter((g) => g !== ''),
      meaning: entry.meaning.trim(),
      note: entry.note?.trim() || undefined,
      source: entry.source ?? 'user',
    };
    const existing = this.userEntries.find((e) => normalizeTerm(e.term) === normalizeTerm(clean.term));
    if (existing) Object.assign(existing, clean);
    else this.userEntries.push(clean);
    this.persist();
    this.reload();
    return this.get(clean.term) ?? clean;
  }

  /** 只删用户库里的条目；内置条目不能删（可以写同名覆盖）。 */
  remove(term: string): boolean {
    const key = normalizeTerm(term);
    const before = this.userEntries.length;
    this.userEntries = this.userEntries.filter((e) => normalizeTerm(e.term) !== key);
    if (this.userEntries.length === before) return false;
    this.persist();
    this.reload();
    return true;
  }

  private persist(): void {
    mkdirSync(dirname(this.userPath), { recursive: true });
    writeFileSync(this.userPath, JSON.stringify({ version: 1, slang: this.userEntries }, null, 2), 'utf8');
  }
}
