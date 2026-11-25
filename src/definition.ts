import type { WorldDefinition } from 'cortico/world.ts';
import { GAMEBUDDY_DEFAULTS, GAMEBUDDY_ID, type GameBuddyConfig } from './config.ts';
import { GameBuddyWorld } from './world.ts';

export const GAMEBUDDY: WorldDefinition<GameBuddyConfig> = {
  id: GAMEBUDDY_ID,
  label: '陪玩搭子-三国杀',
  defaults: () => structuredClone(GAMEBUDDY_DEFAULTS),
  create: (ctx) =>
    new GameBuddyWorld({
      cfg: ctx.cfg,
      dataDir: ctx.dataDir,
      packageDir: ctx.packageDir,
      live: () => ctx.cfg,
      persist: (patch) => ctx.persist(patch),
    }),
  describe: {
    tools: [
      {
        name: 'gamebuddy_status',
        description:
          '读取陪玩搭子的当前状态：游戏有没有在跑、是否在前台、这局陪了多久、主动搭话了几次、有没有读到牌面。只读。',
        parameters: { type: 'object', properties: {} },
        tags: ['game'],
        summary: { zh: '看一眼搭子现在在不在状态。', en: 'Read the buddy’s current state.' },
      },
      {
        name: 'gamebuddy_look',
        description:
          '立刻截游戏窗口并用系统 OCR 读字，返回解析出的局势（身份/体力/手牌/阶段/认出的牌）。识别不出来会明说。',
        parameters: { type: 'object', properties: {} },
        tags: ['game'],
        summary: { zh: '截一张游戏画面，读出牌面。', en: 'Capture the game window and read the board.' },
      },
      {
        name: 'gamebuddy_advise',
        description:
          '按三国杀规则给出这一回合的打法：身份目标、血线、出牌顺序、留牌。可在 situation 里补一句现状。',
        parameters: {
          type: 'object',
          properties: {
            situation: { type: 'string', description: '主人说的当前局势，可为空。' },
            question: { type: 'string', description: '主人具体在纠结什么，可为空。' },
          },
        },
        tags: ['game'],
        summary: { zh: '按规则算一版这一回合该怎么打。', en: 'Compute a rule-based line for this turn.' },
      },
      {
        name: 'gamebuddy_general',
        description: '查本地武将库，返回技能原文与简要打法；未收录会明说并给出补齐办法。',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: '武将名，如"简雍"、"界姜维"。' } },
          required: ['name'],
        },
        tags: ['game'],
        summary: { zh: '本地查一名武将的技能与打法。', en: 'Look a general up in the local book.' },
      },
      {
        name: 'gamebuddy_slang',
        description: '查三国杀黑话库：武将别称、常见梗、术语、牌的简称。命中时顺带返回对应武将的技能。',
        parameters: {
          type: 'object',
          properties: { term: { type: 'string', description: '黑话/别称/简称，如"狗货"、"乐"、"跳反"。' } },
          required: ['term'],
        },
        tags: ['game'],
        summary: { zh: '查一句黑话是什么意思、指哪个武将。', en: 'Look up a slang term and which general it means.' },
      },
      {
        name: 'gamebuddy_teach',
        description: '把武将技能与打法写进本地库，之后查询即为毫秒级。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '武将名。' },
            kingdom: { type: 'string', description: '势力，可空。' },
            hp: { type: 'number', description: '体力上限，可空。' },
            skills: { type: 'array', description: '技能列表 [{name,text}]。', items: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } } } },
            raw: { type: 'string', description: '整段原文（无技能名时）。' },
            play: { type: 'string', description: '一句话打法。' },
          },
          required: ['name'],
        },
        tags: ['game'],
        summary: { zh: '教搭子一个新武将，存进本地库。', en: 'Teach the buddy a new general into the local book.' },
      },
      {
        name: 'gamebuddy_slang_add',
        description: '把一条黑话写进本地黑话库（同一个词再写就覆盖），写完立即生效。',
        parameters: {
          type: 'object',
          properties: {
            term: { type: 'string', description: '词条，如"二锅头"。' },
            meaning: { type: 'string', description: '一句人话释义。' },
            aliases: { type: 'string', description: '别名，逗号分隔，可空。' },
            usage: { type: 'string', description: '用法/场合一句话，可空。' },
            generals: { type: 'string', description: '指涉武将名，逗号分隔，可空。' },
            kind: { type: 'string', description: 'nickname/meme/jargon/card，默认 jargon。' },
          },
          required: ['term', 'meaning'],
        },
        tags: ['game'],
        summary: { zh: '教搭子一条黑话，存进黑话库。', en: 'Teach the buddy a slang entry into the local book.' },
      },
      {
        name: 'gamebuddy_harvest',
        description: '看直播采集清单：最近对局遇到的武将（哪些还没入库）、弹幕里冒出来还没确认的黑话候选。只读。',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'number', description: '最多返回几条，默认 10。' } },
        },
        tags: ['game'],
        summary: { zh: '看看直播里都记下了什么。', en: 'Check what has been harvested from the stream.' },
      },
    ],
    events: [
      {
        type: `${GAMEBUDDY_ID}.start`,
        description: { zh: '检测到游戏窗口，这一局开始。', en: 'A game window appeared; the session starts.' },
        trigger: 'flush',
      },
      {
        type: `${GAMEBUDDY_ID}.tick`,
        description: {
          zh: '该主动搭话的节奏点：已陪时长与最近读到的局势随事件送达。',
          en: 'A moment to speak up, carrying the session length and the latest board reading.',
        },
        trigger: 'flush',
      },
      {
        type: `${GAMEBUDDY_ID}.end`,
        description: { zh: '游戏窗口消失，这一局结束。', en: 'The game window is gone; the session ended.' },
        trigger: 'flush',
      },
      {
        type: `${GAMEBUDDY_ID}.harvest`,
        description: {
          zh: '直播弹幕里同一个词反复出现：值得问主人一句它是什么意思。',
          en: 'A term keeps showing up in the stream chat; worth asking the owner what it means.',
        },
        trigger: 'debounce',
      },
    ],
  },
};
