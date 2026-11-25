/**
 * 直播采集：把「对局里遇到的武将」和「弹幕里出现的黑话」记下来，
 * 攒成待确认清单，让主人一键入库；下次再遇到就认得。
 *
 * 数据分两层：
 * - 内置库（generals.json / slang.json）不动；
 * - 采集结果写 <dataDir>/harvest.json，确认后写进对应 *-user.json。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GeneralHit {
  name: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  via: 'screen' | 'chat';
  /** 武将库里有没有这条；false 表示还得去网上补 */
  learned: boolean;
}

export interface SlangHit {
  term: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** 原文样例，最多留 3 条，方便判断这个词到底怎么用 */
  samples: string[];
  status: 'candidate' | 'accepted' | 'ignored';
}

export interface DanmakuHit {
  at: string;
  user: string;
  text: string;
  slang: string[];
  generals: string[];
}

export interface harvestSession {
  startedAt: string;
  endedAt?: string;
  generals: string[];
  newSlang: number;
}

export interface HarvestState {
  version: 1;
  /** 已处理到的直播事件游标 */
  cursor: number;
  generals: Record<string, GeneralHit>;
  slang: Record<string, SlangHit>;
  recent: DanmakuHit[];
  sessions: harvestSession[];
  /** 上次提醒主人的词，避免同一句反复刷 */
  nudged?: Record<string, string>;
}

export interface HarvestOptions {
  /** 词已经在黑话库里（精确命中） */
  knownSlang: (term: string) => boolean;
  /** 从一段弹幕里认出已知黑话 */
  detectSlang: (text: string) => string[];
  /** 从一段弹幕里认出已知武将 */
  detectGenerals: (text: string) => string[];
  /** 武将库里有没有这个武将 */
  knownGeneral: (name: string) => boolean;
  /** 提醒门槛：同一个候选被提到几次才值得问主人 */
  nudgeAt?: number;
}

const RECENT_MAX = 200;
const SAMPLES_MAX = 3;

/** 弹幕里高频出现、但没有信息量的词，别当候选。 */
const STOP = new Set([
  '主播', '老板', '兄弟', '大家', '各位', '兄弟萌', '老铁', '家人', '水友', '观众',
  '哈哈', '嘿嘿', '呵呵', '嘻嘻', '草', '卧槽', '我靠', '离谱', '牛逼', '厉害', '牛', '强', '弱', '菜',
  '这个', '那个', '就是', '不是', '可以', '没有', '什么', '怎么', '这样', '我们', '你们', '他们',
  '知道', '觉得', '真的', '已经', '现在', '然后', '因为', '所以', '但是', '如果', '还是', '应该',
  '需要', '时候', '一直', '有点', '非常', '特别', '感觉', '可能', '喜欢', '谢谢', '今天', '明天',
  '刚才', '一下', '直接', '真的', '不会', '不能', '不行', '好看', '好玩', '可以', '上来', '下去',
  '什么意思', '干什么', '怎么样', '为什么', '是不是', '有没有', '能不能', '要不要',
  '老师', '大佬', '大神', '新人', '关注', '点赞', '投币', '收藏', '直播间', '弹幕', '游戏', '三国',
]);

const CJK = /[\u4e00-\u9fa5]/u;

/** 这些字出现在片段里，基本就是半句话而不是术语 */
const NOISE_CHARS = /[的了吗呢吧啊呀哦嗯哈嘛呗咯在是我你他她它们这那就都还也又很太更最才而且但所以因为如果可要会能把被给让个些什怎么着过再没别]/u;

/**
 * 从一段话里切出候选词（只取连续汉字片段）。
 * 先把已经认得的黑话/武将名挖掉——不然「狗货又来」会被切成「货又」「又来」这种半截词，
 * 候选清单立刻变成噪声。挖完剩下的连续片段才 2–4 字滑窗。
 */
export function extractCandidates(text: string, known: string[] = []): string[] {
  let body = text.replace(/\[[^\]]*\]/g, ' ');
  for (const term of [...known].filter((t) => t.length >= 2).sort((a, b) => b.length - a.length)) {
    body = body.split(term).join(' ');
  }
  const clean = body.replace(/[^\u4e00-\u9fa5]/gu, ' ');
  const out = new Set<string>();
  for (const run of clean.split(/\s+/u)) {
    if (!run || run.length < 2) continue;
    if (run.length <= 4) {
      out.add(run);
      continue;
    }
    for (let n = 2; n <= 4; n += 1) {
      for (let i = 0; i + n <= run.length; i += 1) out.add(run.slice(i, i + n));
    }
  }
  return [...out].filter((term) => CJK.test(term) && !STOP.has(term) && !NOISE_CHARS.test(term));
}

export class Harvest {
  private state: HarvestState;
  private dirty = false;
  private readonly file: string;
  private readonly opts: HarvestOptions;

  constructor(file: string, opts: HarvestOptions) {
    this.file = file;
    this.opts = opts;
    this.state = Harvest.load(file);
  }

  private static load(file: string): HarvestState {
    const empty: HarvestState = { version: 1, cursor: 0, generals: {}, slang: {}, recent: [], sessions: [] };
    try {
      if (!existsSync(file)) return empty;
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<HarvestState>;
      return {
        version: 1,
        cursor: typeof raw.cursor === 'number' ? raw.cursor : 0,
        generals: raw.generals ?? {},
        slang: raw.slang ?? {},
        recent: Array.isArray(raw.recent) ? raw.recent.slice(-RECENT_MAX) : [],
        sessions: Array.isArray(raw.sessions) ? raw.sessions.slice(-50) : [],
        nudged: raw.nudged ?? {},
      };
    } catch {
      return empty;
    }
  }

  get cursor(): number {
    return this.state.cursor;
  }

  set cursor(value: number) {
    if (value > this.state.cursor) {
      this.state.cursor = value;
      this.dirty = true;
    }
  }

  save(force = false): void {
    if (!this.dirty && !force) return;
    try {
      this.prune();
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
      renameSync(tmp, this.file);
      this.dirty = false;
    } catch {
      /* 写不进去不该打断陪玩，下次再试 */
    }
  }

  /** 记一个武将（画面认出来的，或弹幕里提到的） */
  noteGeneral(name: string, via: 'screen' | 'chat'): void {
    const key = name.trim();
    if (!key) return;
    const now = new Date().toISOString();
    const hit = this.state.generals[key];
    if (hit) {
      hit.count += 1;
      hit.lastSeen = now;
      if (via === 'screen') hit.via = 'screen';
      hit.learned = this.opts.knownGeneral(key);
    } else {
      this.state.generals[key] = {
        name: key,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        via,
        learned: this.opts.knownGeneral(key),
      };
    }
    this.dirty = true;
  }

  /** 联网补库成功后回填标记，免得下次再查一遍 */
  markLearned(name: string): void {
    const hit = this.state.generals[name.trim()];
    if (!hit || hit.learned) return;
    hit.learned = true;
    this.dirty = true;
  }

  /** 弹幕里认出的已知黑话：只记次数与样例，不改库 */
  noteSlangUsage(term: string, sample: string): void {
    const key = term.trim();
    if (!key) return;
    const now = new Date().toISOString();
    const hit = this.state.slang[key];
    if (hit) {
      hit.count += 1;
      hit.lastSeen = now;
      if (sample && !hit.samples.includes(sample)) hit.samples = [...hit.samples, sample].slice(-SAMPLES_MAX);
    } else {
      this.state.slang[key] = {
        term: key,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        samples: sample ? [sample] : [],
        status: 'accepted',
      };
    }
    this.dirty = true;
  }

  /** 一条弹幕：认已知的，攒未知的。`scope` 关掉的那一侧不记（武将库/黑话库各有开关）。 */
  noteDanmaku(text: string, user = '', scope: { slang?: boolean; generals?: boolean } = {}): DanmakuHit | null {
    const body = text.trim();
    if (!body) return null;
    const wantSlang = scope.slang !== false;
    const wantGenerals = scope.generals !== false;
    const known = wantSlang ? this.opts.detectSlang(body) : [];
    const gens = wantGenerals ? this.opts.detectGenerals(body) : [];
    for (const term of known) this.noteSlangUsage(term, body);
    for (const g of gens) this.noteGeneral(g, 'chat');
    const fresh: string[] = [];
    if (wantSlang) {
      for (const term of extractCandidates(body, [...known, ...gens])) {
        if (this.opts.knownSlang(term)) continue;
        if (this.state.slang[term]?.status === 'ignored') continue;
        const now = new Date().toISOString();
        const hit = this.state.slang[term];
        if (hit) {
          if (hit.status !== 'candidate') continue;
          hit.count += 1;
          hit.lastSeen = now;
          if (!hit.samples.includes(body)) hit.samples = [...hit.samples, body].slice(-SAMPLES_MAX);
        } else {
          this.state.slang[term] = {
            term,
            count: 1,
            firstSeen: now,
            lastSeen: now,
            samples: [body],
            status: 'candidate',
          };
        }
        fresh.push(term);
        this.dirty = true;
      }
    }
    const rec: DanmakuHit = {
      at: new Date().toISOString(),
      user,
      text: body,
      slang: known,
      generals: gens,
    };
    this.state.recent = [...this.state.recent, rec].slice(-RECENT_MAX);
    this.dirty = true;
    void fresh;
    return rec;
  }

  /**
   * 待确认的黑话候选，按出现次数降序。
   * 只留下被提过两次以上的（一次的词多半是句子碎片），并且丢掉被更长候选包住的短词。
   */
  candidates(limit = 50): SlangHit[] {
    const pool = Object.values(this.state.slang).filter((s) => s.status === 'candidate' && s.count >= 2);
    const keep = pool.filter(
      (hit) =>
        !pool.some(
          (other) =>
            other.term !== hit.term &&
            other.term.includes(hit.term) &&
            (other.count > hit.count || (other.count === hit.count && other.term.length > hit.term.length)),
        ),
    );
    return keep.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, limit);
  }

  /** 已经攒够次数、还没问过主人的候选 */
  nextNudge(): SlangHit | null {
    const threshold = this.opts.nudgeAt ?? 3;
    const nudge = this.state.nudged ?? (this.state.nudged = {});
    const hit = this.candidates(30).find((c) => c.count >= threshold && !nudge[c.term]);
    return hit ?? null;
  }

  markNudged(term: string): void {
    this.state.nudged = { ...(this.state.nudged ?? {}), [term]: new Date().toISOString() };
    this.dirty = true;
  }

  accept(term: string): SlangHit | null {
    const hit = this.state.slang[term];
    if (!hit) return null;
    hit.status = 'accepted';
    // 同一个概念的其它切法（翻盘点 / 翻盘 / 盘点）一起收掉，别在清单里重复出现
    for (const [key, other] of Object.entries(this.state.slang)) {
      if (key !== term && other.status === 'candidate' && (key.includes(term) || term.includes(key))) {
        other.status = 'ignored';
      }
    }
    this.dirty = true;
    return hit;
  }

  ignore(term: string): boolean {
    const hit = this.state.slang[term];
    if (!hit) return false;
    hit.status = 'ignored';
    this.dirty = true;
    return true;
  }

  /** 武将命中列表，未入库的排前面 */
  generalHits(limit = 60): GeneralHit[] {
    return Object.values(this.state.generals)
      .sort((a, b) => Number(a.learned) - Number(b.learned) || b.count - a.count)
      .slice(0, limit);
  }

  recentDanmaku(limit = 40): DanmakuHit[] {
    return this.state.recent.slice(-limit).reverse();
  }

  /** 一局开始：开一个采集段 */
  beginSession(): void {
    const last = this.state.sessions[this.state.sessions.length - 1];
    if (last && !last.endedAt) return;
    this.state.sessions = [...this.state.sessions, { startedAt: new Date().toISOString(), generals: [], newSlang: 0 }].slice(-50);
    this.dirty = true;
  }

  /** 一局结束：把这段里遇到的武将、新增候选数记进段落 */
  endSession(): harvestSession | null {
    const last = this.state.sessions[this.state.sessions.length - 1];
    if (!last || last.endedAt) return null;
    const since = Date.parse(last.startedAt);
    last.endedAt = new Date().toISOString();
    last.generals = this.generalHits(200)
      .filter((g) => Date.parse(g.lastSeen) >= since)
      .map((g) => g.name);
    last.newSlang = Object.values(this.state.slang).filter(
      (s) => s.status === 'candidate' && Date.parse(s.firstSeen) >= since,
    ).length;
    this.dirty = true;
    return last;
  }

  stats(): { generals: number; candidates: number; accepted: number; danmaku: number; sessions: number } {
    const slang = Object.values(this.state.slang);
    return {
      generals: Object.keys(this.state.generals).length,
      // 和列表口径一致：只算「值得看」的候选，不把一次性的句子碎片算进去
      candidates: this.candidates(9999).length,
      accepted: slang.filter((s) => s.status === 'accepted').length,
      danmaku: this.state.recent.length,
      sessions: this.state.sessions.length,
    };
  }

  /** 清掉两小时内只出现过一次的碎片，避免 harvest.json 越滚越大 */
  private prune(now = Date.now()): void {
    const cutoff = now - 2 * 3600_000;
    for (const [term, hit] of Object.entries(this.state.slang)) {
      if (hit.status === 'candidate' && hit.count < 2 && Date.parse(hit.lastSeen) < cutoff) {
        delete this.state.slang[term];
        this.dirty = true;
      }
    }
  }
}
