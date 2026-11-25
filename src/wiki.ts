/**
 * 从三国杀 wiki 抓一名武将——多数据源，按顺序 fallback。
 *
 * 三个源都是 biligame 的 MediaWiki（同一套「武将」模板），所以解析逻辑共用，
 * 只是站点不同：
 *   msgs  = 三国杀移动版（首选，手机上打的版本）
 *   sgs   = 三国杀（综合，覆盖面最广）
 *   sgsol = 三国杀 OL
 *
 * 只在这里联网：查不到时按顺序抓一次，第一个拿到技能的源胜出，
 * 解析成库条目后交给 GeneralBook 存起来，以后就是本地命中。
 * 抓取失败不抛错——调用方要能退回"库里没有"。
 */
export interface WikiGeneral {
  name: string;
  kingdom?: string;
  hp?: number;
  skills: Array<{ name: string; text: string }>;
  sourceUrl: string;
  /** 命中来源的短 id（msgs/sgs/sgsol），写进词条便于追溯。 */
  sourceId?: string;
  /** 命中来源的显示名，例如「三国杀移动版」。 */
  sourceLabel?: string;
}

export interface WikiSource {
  id: string;
  label: string;
  api: string;
  page: string;
}

export const WIKI_SOURCES: WikiSource[] = [
  { id: 'msgs', label: '三国杀移动版', api: 'https://wiki.biligame.com/msgs/api.php', page: 'https://wiki.biligame.com/msgs/' },
  { id: 'sgs', label: '三国杀', api: 'https://wiki.biligame.com/sgs/api.php', page: 'https://wiki.biligame.com/sgs/' },
  { id: 'sgsol', label: '三国杀OL', api: 'https://wiki.biligame.com/sgsol/api.php', page: 'https://wiki.biligame.com/sgsol/' },
];

export const WIKI_SOURCE_IDS = WIKI_SOURCES.map((s) => s.id);

/** 按 id 列表挑出源；未知 id 忽略，空列表退回全部。 */
export function pickSources(ids?: string[]): WikiSource[] {
  if (!ids || ids.length === 0) return WIKI_SOURCES;
  const wanted = new Map(WIKI_SOURCES.map((s) => [s.id, s]));
  const out = ids.map((id) => wanted.get(id)).filter((s): s is WikiSource => Boolean(s));
  return out.length > 0 ? out : WIKI_SOURCES;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#160': ' ',
  '#39': "'",
};

function decode(text: string): string {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
      const key = code.toLowerCase();
      if (ENTITIES[key] !== undefined) return ENTITIES[key];
      if (key.startsWith('#x')) return String.fromCodePoint(Number.parseInt(key.slice(2), 16));
      if (key.startsWith('#')) return String.fromCodePoint(Number(key.slice(1)));
      return whole;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html: string): string {
  return decode(
    html
      .replace(/<sup[\s\S]*?<\/sup>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\[\d+\]/g, ''),
  );
}

async function getJson(url: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'cortico-world-gamebuddy/0.1 (+desktop pet)' },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 皮肤页（`逆拒袁术*刘繇`）、列表页（`武将`/`皮肤`/`新手`）、模板/分类都不是武将词条。 */
function isArticle(title: string, name: string): boolean {
  if (!title) return false;
  if (/[:：]/.test(title)) return false; // 模板:/分类:/文件:
  if (title.includes('*')) return false; // 皮肤页
  if (/^(武将|皮肤|新手|首页|图鉴|战功|装备|技能)$/u.test(title)) return false;
  return title.includes(name);
}

/** 在某个源里找最像该武将的页面标题。 */
async function findTitle(source: WikiSource, name: string, timeoutMs: number): Promise<string | null> {
  const query = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: name,
    srlimit: '10',
    format: 'json',
    formatversion: '2',
  });
  const data = await getJson(`${source.api}?${query.toString()}`, timeoutMs);
  const search = (data?.query as { search?: Array<{ title?: string }> } | undefined)?.search ?? [];
  const titles = search.map((s) => String(s.title ?? '')).filter(Boolean);
  if (titles.length === 0) return null;

  const pool = titles.filter((t) => isArticle(t, name));
  const candidates = pool.length > 0 ? pool : titles;
  const norm = (s: string): string => s.replace(/\s/g, '');

  return (
    candidates.find((t) => norm(t) === norm(name)) ??
    candidates.find((t) => t === `界${name}` || t === `SP${name}` || t === `sp${name}` || t === `谋${name}`) ??
    candidates.find((t) => norm(t).startsWith(norm(name))) ??
    candidates.find((t) => t.includes(name)) ??
    null
  );
}

/** 技能块：`<div class="basic-info-row-label…"><a title="巧说">巧说</a></div><div>描述</div>` */
function parseSkills(html: string): Array<{ name: string; text: string }> {
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const pattern =
    /<div class="basic-info-row-label[^"]*"[^>]*>\s*<a[^>]*title="([^"]+)"[^>]*>[\s\S]*?<\/a>\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/g;
  const out: Array<{ name: string; text: string }> = [];
  const seen = new Set<string>();
  for (const match of cleaned.matchAll(pattern)) {
    const name = decode(match[1]);
    const text = stripTags(match[2]);
    if (!name || !text) continue;
    if (seen.has(name)) continue; // 经典/界限/自走棋 同名技能只留第一次（经典版本）
    seen.add(name);
    out.push({ name, text });
    if (out.length >= 6) break;
  }
  // 国战专用技能（副将技/主将技/阵法技/阴阳鱼）在身份局用不上：有别的技能时先剔掉。
  const isGuozhan = (text: string): boolean => /副将技|主将技|阵法技|阴阳鱼/u.test(text);
  const combat = out.filter((s) => !isGuozhan(s.text));
  return combat.length > 0 ? combat : out;
}

/** 单个源的抓取：找不到/没技能都返回 null，让调用方换下一个源。 */
async function fetchFromSource(source: WikiSource, name: string, timeoutMs: number): Promise<WikiGeneral | null> {
  const title = await findTitle(source, name, timeoutMs);
  if (!title) return null;

  const query = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext|text',
    format: 'json',
    formatversion: '2',
    redirects: '1',
  });
  const data = await getJson(`${source.api}?${query.toString()}`, timeoutMs);
  const parse = data?.parse as { title?: string; wikitext?: string; text?: string } | undefined;
  if (!parse?.text) return null;

  const skills = parseSkills(parse.text);
  if (skills.length === 0) return null;

  const wikitext = parse.wikitext ?? '';
  const kingdom = wikitext.match(/\|势力\s*=\s*([魏蜀吴群晋神])/u)?.[1];
  const hpRaw =
    wikitext.match(/\|经典体力\s*=\s*(\d{1,2})/u)?.[1] ??
    wikitext.match(/\|体力\s*=\s*(\d{1,2})/u)?.[1] ??
    wikitext.match(/\|(?:界限突破|国战)体力\s*=\s*(\d{1,2})/u)?.[1];
  const hp = hpRaw ? Number(hpRaw) : undefined;

  return {
    name: decode(parse.title ?? title),
    kingdom,
    hp,
    skills,
    sourceUrl: `${source.page}${encodeURIComponent(title)}`,
    sourceId: source.id,
    sourceLabel: source.label,
  };
}

export interface FetchOptions {
  /** 源顺序；默认 msgs → sgs → sgsol。 */
  sources?: string[];
  /** 每个源的超时。 */
  timeoutMs?: number;
}

/** 依次问每个源，第一个拿到技能的直接返回。全部失败返回 null。 */
export async function fetchGeneral(name: string, timeoutMs = 9000, opts: FetchOptions = {}): Promise<WikiGeneral | null> {
  const clean = name.replace(/\s+/g, '');
  if (!clean) return null;
  const per = opts.timeoutMs ?? timeoutMs;
  for (const source of pickSources(opts.sources)) {
    const general = await fetchFromSource(source, clean, per);
    if (general) return general;
  }
  return null;
}
