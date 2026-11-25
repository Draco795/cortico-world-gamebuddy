/**
 * 本地武将库：查技能不再靠模型回忆，而是一次文件查找。
 *
 * 两层：内置库（随包分发，data/generals.json）+ 用户库（dataDir/generals-user.json，
 * 由 gamebuddy_teach 写入）。用户库同名条目覆盖内置条目，方便改错或补新将。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GeneralSkill {
  name: string;
  text: string;
}

export interface General {
  name: string;
  alias?: string[];
  kingdom?: string;
  hp?: number;
  skills: GeneralSkill[];
  play?: string;
  counter?: string;
  source?: string;
}

interface BookFile {
  version?: number;
  generals?: General[];
}

/** 界面里的武将名常带前缀；查库前先剥掉。 */
const PREFIX = /^(界|SP|sp|Sp|神|新|旧|OL|ol|国战|标准|风|火|林|山|一将成名)+/u;

/** 常见繁简差异，OCR 与客户端都可能出现。 */
const TRAD: Record<string, string> = {
  簡: '简', 滿: '满', 寵: '宠', 劉: '刘', 維: '维', 孫: '孙', 權: '权', 呂: '吕',
  黃: '黄', 葛: '葛', 張: '张', 趙: '赵', 馬: '马', 華: '华', 魯: '鲁', 肅: '肃',
  龐: '庞', 鄒: '邹', 陸: '陆', 遜: '逊', 週: '周', 瑜: '瑜',
};

export function normalizeName(raw: string): string {
  let name = raw.replace(/\s+/g, '').trim();
  name = name.replace(/[簡滿寵劉維孫權呂黃張趙馬華魯肅龐鄒陸遜週]/gu, (ch) => TRAD[ch] ?? ch);
  return name;
}

/** 去掉「界/SP/神/OL」这类前缀后的名字，只用作查不到的兜底。 */
export function baseName(raw: string): string {
  return normalizeName(raw).replace(PREFIX, '');
}

function loadFile(path: string): General[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as BookFile | General[];
    const list = Array.isArray(parsed) ? parsed : parsed.generals ?? [];
    return list.filter((g) => g && typeof g.name === 'string' && Array.isArray(g.skills));
  } catch {
    return [];
  }
}

export class GeneralBook {
  private readonly byName = new Map<string, General>();
  /** 去前缀后的兜底索引：界姜维 查不到时退到 姜维。 */
  private readonly byBase = new Map<string, General>();
  private readonly userPath: string;
  private readonly builtinPath: string;
  private userGenerals: General[] = [];
  private builtinGenerals: General[] = [];

  constructor(builtinPath: string, userPath: string) {
    this.builtinPath = builtinPath;
    this.userPath = userPath;
    this.reload();
  }

  reload(): void {
    this.byName.clear();
    this.byBase.clear();
    const builtin = loadFile(this.builtinPath);
    this.builtinGenerals = builtin;
    this.userGenerals = loadFile(this.userPath);
    // 先内置后用户：用户条目覆盖同名内置
    for (const g of [...builtin, ...this.userGenerals]) {
      const key = normalizeName(g.name);
      const entry: General = { ...g, source: g.source ?? (this.userGenerals.includes(g) ? 'user' : 'builtin') };
      this.byName.set(key, entry);
      // 兜底索引：名字本身没有前缀的（郭嘉）优先占位，别让 神郭嘉 抢走
      const base = baseName(g.name);
      if (!this.byBase.has(base) || key === base) this.byBase.set(base, entry);
      for (const a of g.alias ?? []) {
        const ak = normalizeName(a);
        this.byName.set(ak, entry);
        if (!this.byBase.has(baseName(a))) this.byBase.set(baseName(a), entry);
      }
    }
  }

  get size(): number {
    return this.byName.size;
  }

  get builtinSize(): number {
    return this.builtinGenerals.length;
  }

  /** 全部武将（按名字去重），供编辑器页面展示。 */
  list(): General[] {
    const seen = new Set<string>();
    const out: General[] = [];
    for (const general of this.byName.values()) {
      const key = normalizeName(general.name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(general);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  /** 是不是内置条目（内置的不能删，只能写同名覆盖）。 */
  isBuiltin(raw: string): boolean {
    const key = normalizeName(raw);
    return this.builtinGenerals.some((g) => normalizeName(g.name) === key);
  }

  /** 只删用户库里的条目。 */
  remove(raw: string): boolean {
    const key = normalizeName(raw);
    const before = this.userGenerals.length;
    this.userGenerals = this.userGenerals.filter((g) => normalizeName(g.name) !== key);
    if (this.userGenerals.length === before) return false;
    mkdirSync(dirname(this.userPath), { recursive: true });
    writeFileSync(this.userPath, JSON.stringify({ version: 1, generals: this.userGenerals }, null, 2), 'utf8');
    this.reload();
    return true;
  }

  lookup(raw: string): General | null {
    const key = normalizeName(raw);
    if (!key) return null;
    const direct = this.byName.get(key);
    if (direct) return direct;
    // 去前缀兜底：界姜维 → 姜维
    const loose = this.byBase.get(baseName(raw));
    if (loose) return loose;
    // 容错：包含关系（"界简雍(蜀)" 这类脏输入）
    for (const [name, general] of this.byName) {
      if (name.length >= 2 && (key.includes(name) || name.includes(key))) return general;
    }
    return null;
  }

  /** 在 OCR 文本里找出库里认识的武将名（长名优先，避免"诸葛"抢"诸葛亮"）。 */
  detect(text: string): General[] {
    const flat = text.replace(/\s+/g, '');
    if (!flat) return [];
    const hits: General[] = [];
    const seen = new Set<string>();
    const takenKeys: string[] = [];
    const names = [...this.byName.keys()].sort((a, b) => b.length - a.length);
    for (const name of names) {
      if (name.length < 2) continue;
      if (!flat.includes(name)) continue;
      // 已经被更长的名字吃掉了（"神郭嘉" 里的 "郭嘉" 不再单独算一次）
      if (takenKeys.some((t) => t.includes(name))) continue;
      const general = this.byName.get(name)!;
      takenKeys.push(name);
      if (seen.has(general.name)) continue;
      seen.add(general.name);
      hits.push(general);
      if (hits.length >= 6) break;
    }
    return hits;
  }

  /** 给模型看的一段完整词条。 */
  format(general: General): string {
    const head = `【${general.name}】${general.kingdom ?? '?'} ${general.hp ?? '?'} 血`;
    const skills = general.skills.map((s) => `${s.name}：${s.text}`);
    const tail = [
      general.play ? `打法：${general.play}` : '',
      general.counter ? `克制：${general.counter}` : '',
    ].filter((line) => line !== '');
    return [head, ...skills, ...tail].join('\n');
  }

  /** 塞进环境提示词的极简版：一行一个。 */
  brief(general: General): string {
    const skills = general.skills.map((s) => `${s.name}=${s.text}`).join('；');
    return `${general.name}(${general.kingdom ?? '?'}${general.hp ?? '?'})：${skills}${general.play ? `。打法：${general.play}` : ''}`;
  }

  /** 写入用户库；同名覆盖。 */
  teach(general: General): General {
    const clean: General = {
      name: general.name.replace(/\s+/g, ''),
      kingdom: general.kingdom,
      hp: general.hp,
      skills: general.skills.filter((s) => s.name && s.text),
      play: general.play,
      counter: general.counter,
      // 保留调用方给的来源（如 "web <url>"），否则记成手工录入
      source: general.source ?? 'user',
    };
    const existing = this.userGenerals.find((g) => normalizeName(g.name) === normalizeName(clean.name));
    if (existing) Object.assign(existing, clean);
    else this.userGenerals.push(clean);

    mkdirSync(dirname(this.userPath), { recursive: true });
    writeFileSync(
      this.userPath,
      JSON.stringify({ version: 1, generals: this.userGenerals }, null, 2),
      'utf8',
    );
    this.reload();
    return this.lookup(clean.name) ?? clean;
  }
}
