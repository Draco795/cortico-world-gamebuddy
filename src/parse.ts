/**
 * 三国杀牌面解析：把 OCR 出的文字行，尽量拼成一份"够用"的局势。
 *
 * 刻意做成宽松启发式而不是严格模板：不同客户端（OL、十周年、无名杀、手机投屏）
 * 的排版差别很大，这里只认牌名、身份、血量、手牌数、阶段这几类稳定文字，
 * 认不出的部分留空，由搭子自己承认"看不清"，而不是编。
 */

export type Identity = 'lord' | 'loyal' | 'rebel' | 'spy';

export interface BoardState {
  identity?: Identity;
  identityText?: string;
  /** 画面上出现过的身份词（一屏往往有多名玩家的身份牌）。 */
  identitiesSeen: string[];
  hp?: { current: number; max: number };
  handSize?: number;
  phase?: string;
  cards: string[];
  /** 只在"手牌区"里认出的牌，比全屏认出的更可信。 */
  handCards: string[];
  hazards: string[];
  lines: string[];
  /** 解析置信度 0-1，粗略反映认出了多少字段。 */
  confidence: number;
}

const CARD_NAMES = [
  '无懈可击', '万箭齐发', '南蛮入侵', '桃园结义', '五谷丰登', '无中生有',
  '顺手牵羊', '过河拆桥', '借刀杀人', '铁索连环', '决斗', '火攻', '火杀', '雷杀',
  '诸葛连弩', '青釭剑', '雌雄双股剑', '青龙偃月刀', '丈八蛇矛', '贯石斧', '方天画戟',
  '麒麟弓', '寒冰剑', '古锭刀', '朱雀羽扇', '白银狮子', '八卦阵', '仁王盾', '藤甲',
  '的卢', '赤兔', '大宛', '紫骍', '绝影', '爪黄飞电', '骅骝',
  '杀', '闪', '桃', '酒',
];

const HAZARDS = ['乐不思蜀', '兵粮寸断', '闪电'];

/** OCR 最常见的字形混淆；先归一化再认牌，能少漏一半。 */
const OCR_ALIASES: Array<[RegExp, string]> = [
  [/賊/g, '贼'],
  [/褚葛|渚葛|诸菖|诸哥/g, '诸葛'],
  [/还弩|连努|连驽|连弯/g, '连弩'],
  [/无解可击|无懈可擎|无懈可基/g, '无懈可击'],
  [/决抖|决斗/g, '决斗'],
  [/南蛮人侵|南蛮入侵/g, '南蛮入侵'],
  [/万剑齐发|万箭齐发/g, '万箭齐发'],
  [/顺手牵羊|顺子牵羊/g, '顺手牵羊'],
  [/过河拆桥|过河拆乔/g, '过河拆桥'],
  [/桃园结义|桃园结意/g, '桃园结义'],
  [/白银狮子|白艮狮子/g, '白银狮子'],
  [/八卦阵|八卦陈/g, '八卦阵'],
];

function normalizeOcr(text: string): string {
  // 先去掉书名号/括号这类夹在字与字之间的噪声（"褚葛《还弩"），再套别名
  let out = text.replace(/[《》〈〉「」『』【】\[\]()（）·]/g, '');
  for (const [pattern, replacement] of OCR_ALIASES) out = out.replace(pattern, replacement);
  return out;
}

const IDENTITY_WORDS: Array<{ word: string; id: Identity }> = [
  { word: '主公', id: 'lord' },
  { word: '忠臣', id: 'loyal' },
  { word: '反贼', id: 'rebel' },
  { word: '内奸', id: 'spy' },
];

export function parseBoard(lines: string[]): BoardState {
  const clean = lines.map((l) => l.replace(/\s+/g, '')).filter((l) => l !== '');
  const joined = normalizeOcr(clean.join('|'));
  const state: BoardState = { cards: [], handCards: [], hazards: [], lines: clean.slice(0, 80), confidence: 0, identitiesSeen: [] };

  for (const { word, id } of IDENTITY_WORDS) {
    if (joined.includes(word)) {
      state.identitiesSeen.push(word);
      if (state.identity === undefined) {
        state.identity = id;
        state.identityText = word;
        state.confidence += 0.3;
      }
    }
  }

  const hpMatch = joined.match(/(\d{1,2})\s*[/／]\s*(\d{1,2})/);
  if (hpMatch) {
    const current = Number(hpMatch[1]);
    const max = Number(hpMatch[2]);
    if (current >= 0 && max > 0 && current <= max && max <= 8) {
      state.hp = { current, max };
      state.confidence += 0.3;
    }
  }

  const handMatch =
    joined.match(/(?:手牌|手牌数|牌数)\D{0,3}(\d{1,2})/)
    // OCR 常把"手牌 5"读成"手5"（"牌"字被卡面吞掉），留一条窄兜底
    ?? joined.match(/手(\d{1,2})(?!\d)/);
  if (handMatch) {
    state.handSize = Number(handMatch[1]);
    state.confidence += 0.15;
  }

  // "牌"字在卡面里最容易被 OCR 认成"牒""脾"之类，先归一化再认
  const phaseText = joined.replace(/出[牒脾牌]/g, '出牌');
  const phaseMatch = phaseText.match(/(判定|摸牌|出牌|弃牌|结束)阶段?/);
  if (phaseMatch) {
    state.phase = `${phaseMatch[1]}阶段`;
    state.confidence += 0.1;
  }

  for (const card of CARD_NAMES) {
    if (joined.includes(card)) state.cards.push(card);
  }
  for (const hazard of HAZARDS) {
    if (joined.includes(hazard)) state.hazards.push(hazard);
  }
  if (state.cards.length > 0) state.confidence += 0.15;
  state.confidence = Math.min(1, Math.round(state.confidence * 100) / 100);
  return state;
}

/** 一行话说完当前局势，用于事件正文与工具回执。 */
export function describeState(state: BoardState): string {
  const parts: string[] = [];
  parts.push(state.identityText ? `身份 ${state.identityText}` : '身份未知');
  parts.push(state.hp ? `体力 ${state.hp.current}/${state.hp.max}` : '体力未知');
  if (state.handSize !== undefined) parts.push(`手牌数 ${state.handSize}`);
  if (state.phase) parts.push(`当前 ${state.phase}`);
  if (state.hazards.length > 0) parts.push(`判定区 ${state.hazards.join('、')}`);
  if (state.identitiesSeen.length > 1) parts.push(`场上身份 ${state.identitiesSeen.join('、')}`);
  if (state.handCards.length > 0) parts.push(`手牌（认出 ${state.handCards.length} 张）${state.handCards.join('、')}`);
  else if (state.cards.length > 0) parts.push(`认出的牌 ${state.cards.slice(0, 8).join('、')}`);
  return parts.join('｜');
}

/** 给模型看的摘要：局势 + 置信度提示，避免它把猜测当事实。 */
export function stateBrief(state: BoardState): string {
  const conf = state.confidence >= 0.7 ? '高' : state.confidence >= 0.4 ? '中' : '低';
  return `${describeState(state)}（识别置信度：${conf}）`;
}

// ---------------------------------------------------------------- 分区读屏

export interface RegionLines {
  id: string;
  lines: string[];
}

export interface BoardReading extends BoardState {
  /** 身份人数，如「主×1 忠×1 反×2 内×1」。 */
  counts?: string;
  /** 胜负目标提示，如「找出反贼忠臣 / 最后击败主公」。 */
  objective?: string;
}

function cardsIn(text: string): string[] {
  const joined = normalizeOcr(text.replace(/\s+/g, ''));
  const found = CARD_NAMES.filter((card) => joined.includes(card));
  // 「闪」是单字大图，OCR 常认成 门/閈/閂 这类外形相近的字，只在手牌区兜底
  const flashLikely = /[门閈閂闩閊]/g.test(joined) && !found.includes('闪');
  if (flashLikely) found.push('闪');
  return found;
}

/**
 * 分区解析：手牌区、身份计数区、桌面区分开读。
 * 整屏 OCR 会把"主×1"当成你的身份、把别人装备当你的手牌——
 * 分区之后这些混淆就没了。
 */
export function parseRegions(regions: readonly RegionLines[]): BoardReading {
  const get = (id: string) => regions.find((r) => r.id === id)?.lines ?? [];
  const hand = get('hand');
  const status = get('status');
  const self = get('self');
  const table = regions
    .filter((r) => r.id !== 'hand' && r.id !== 'status' && r.id !== 'self')
    .flatMap((r) => r.lines);

  const state: BoardReading = { ...parseBoard([...status, ...table, ...hand]) };
  state.handCards = cardsIn(hand.join(''));

  const flatStatus = status.map((l) => l.replace(/\s+/g, ''));
  // 身份计数是图标 + 数字，字认不出，但"×1 ×1 ×2 ×1"这四个数字的顺序是稳定的
  const numbers = (flatStatus.join('|').match(/[x×*]\s*(\d{1,2})/g) ?? []).map((s) => s.replace(/\D/g, ''));
  if (numbers.length === 4) {
    state.counts = `主×${numbers[0]} 忠×${numbers[1]} 反×${numbers[2]} 内×${numbers[3]}`;
  } else {
    const countLine = flatStatus.find((l) => /[x×*]\d/.test(l));
    if (countLine) state.counts = countLine;
  }
  const objective = status
    .filter((l) => /反贼|忠臣|主公|内奸/.test(normalizeOcr(l.replace(/\s+/g, ''))))
    .join(' / ');
  if (objective) state.objective = objective;

  const limit = hand.concat(self).join('').match(/(\d{1,2})\s*[/／]\s*(\d{1,2})/);
  if (limit && Number(limit[1]) <= 20) state.handSize = Number(limit[1]);

  return state;
}
