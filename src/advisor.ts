/**
 * 三国杀决策规则：不联网、不调模型，纯代码给出可直接执行的建议。
 *
 * 为什么要有它：桌宠背后的模型未必懂三国杀牌序，或者会一本正经地胡说。
 * 这一层把"身份目标 / 血线 / 牌序 / 留牌 / AOE 时机 / 无懈用法"固化成规则，
 * 模型只负责把它讲得像个人话，而不是从零推理。
 */
import type { BoardState, Identity } from './parse.ts';

export interface Advice {
  headline: string;
  bullets: string[];
  caution?: string;
}

const IDENTITY_GOAL: Record<Identity, string> = {
  lord: '你是主公：活到最后就是赢。先保命、保忠臣，别为了追击把自己打进斩杀线。',
  loyal: '你是忠臣：主公死=你输。所有决策先问"这会不会让主公掉血"，再谈输出。',
  rebel: '你是反贼：主公死=你赢。所有资源优先往主公身上砸，别在忠臣身上刷伤害。',
  spy: '你是内奸：要控场，不能让任何一方太快结束；先清小角色，最后留一个能单挑的局面。',
};

const ORDER_ADVICE = [
  '出牌顺序：先拆顺（过河拆桥/顺手牵羊）破对方关键装备或手牌 → 再杀 → 再锦囊（决斗、AOE）→ 最后装备与过牌（无中生有）。',
  '有【诸葛连弩】且手里多杀，才值得为连杀卖血；否则杀一次就够，留着闪。',
  '【无懈可击】留给乐不思蜀、兵粮寸断、决斗、南蛮、万箭这类能改变节奏的牌，不要拿去抵消无中生有。',
];

function keepAdvice(state: BoardState): string {
  const tips: string[] = [];
  if (state.hp && state.hp.current <= 1) {
    tips.push('你现在 1 血：优先留【桃】【闪】，宁可这回合不出杀，也不要空手进别人回合。');
  } else if (state.hp && state.hp.current <= 2) {
    tips.push('2 血及以下属于斩杀线：手上至少留一张闪或桃，别把防御牌全打出去。');
  }
  if (state.identity === 'lord' || state.identity === 'loyal') {
    tips.push('主公/忠臣：场上 AOE 多时手里常备【桃】，救主公的一张桃比多打一点伤害值。');
  }
  if (state.identity === 'rebel') {
    tips.push('反贼：残局留住【杀】和【决斗】，主公剩 1 血时你需要的是一张能直接打到他的牌。');
  }
  if (tips.length === 0) tips.push('常规留牌：一张闪 + 一张桃打底，剩下的按这回合能不能形成压制来取舍。');
  return tips.join(' ');
}

export function advise(state: BoardState, question: string | undefined, posture: string): Advice {
  const bullets: string[] = [];
  const identity = state.identity;
  const headline = identity
    ? IDENTITY_GOAL[identity].split('：')[0] + '。'
    : '先确认身份，再谈打法——身份决定你该打谁。';

  if (identity) bullets.push(IDENTITY_GOAL[identity]);

  if (state.hp && state.hp.current <= 2) {
    bullets.push(`血线告急（${state.hp.current}/${state.hp.max}）：这一回合的目标是活到下一回合，不是换血。`);
  }

  if (state.hazards.length > 0) {
    bullets.push(`判定区有 ${state.hazards.join('、')}：先算判定，乐不思蜀/兵粮寸断会让你整回合空过，能解就解。`);
  }

  bullets.push(ORDER_ADVICE[0]);
  bullets.push(keepAdvice(state));

  if (state.cards.length > 0) {
    bullets.push(`你认出的牌：${state.cards.join('、')}。按上面的顺序把它们排一遍，别先装备后拆顺。`);
  }

  const caution = posture === 'coach'
    ? '如果 OCR 没读全，先让主人补一句"我手上有什么"，再给结论。'
    : undefined;

  if (question && question.trim() !== '') {
    bullets.unshift(`针对你的问题「${question.trim().slice(0, 60)}」：先看身份目标，再看这一回合能不能直接推进它。`);
  }

  return { headline, bullets: bullets.slice(0, 4), caution };
}

export function renderAdvice(advice: Advice): string {
  const lines = [advice.headline, ...advice.bullets.map((b, i) => `${i + 1}. ${b}`)];
  if (advice.caution) lines.push(`⚠ ${advice.caution}`);
  return lines.join('\n');
}
