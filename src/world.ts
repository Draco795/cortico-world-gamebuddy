/**
 * 陪玩搭子：把"桌宠知道你在打游戏"这件事变成一等的世界能力。
 *
 * 三件事，按成本从低到高：
 *   1. 窗口观测（每 pollSec 秒一次 PowerShell，几乎零成本）→ 上号/收工/节奏搭话；
 *   2. 读屏（按需，截图 + Windows OCR）→ 牌面文字 → 三国杀解析；
 *   3. 规则建议（纯代码）→ 身份目标、血线、牌序、留牌，模型只负责说人话。
 *
 * 设计上刻意不让这个包自己调模型：事件交给宿主，宿主把话交给桌宠的模型；
 * 这样语气、人格、记忆都还是主人原来那只宠物。
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldHost, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { GAMEBUDDY_DEFAULTS, GAMEBUDDY_ID, gamebuddyConfigGroup, type GameBuddyConfig } from './config.ts';
import { advise, renderAdvice } from './advisor.ts';
import { GeneralBook, type General, type GeneralSkill } from './generals.ts';
import { SlangBook, type SlangEntry, type SlangKind } from './slang.ts';
import { Harvest, type SlangHit } from './harvest.ts';
import { startEditor, type EditorHandle } from './editor.ts';
import { fetchGeneral, WIKI_SOURCE_IDS } from './wiki.ts';
import { captureWindow, cropImage, detect, ocrImage, ocrRegions, sharpnessOf, type Region, type WindowInfo } from './observe.ts';
import { parseBoard, parseRegions, stateBrief, type BoardState } from './parse.ts';

const PANEL = 'main';

/**
 * 三国杀（手机版/模拟器）的版面分区，坐标是相对窗口的比例。
 * 这些框是按 1534×881 的雷电窗口量的；换分辨率仍按比例走，误差在可接受范围。
 */
const SANGUOSHA_REGIONS: readonly Region[] = [
  { id: 'status', x: 0.0, y: 0.05, w: 0.32, h: 0.16, scale: 2.2 },
  { id: 'table', x: 0.02, y: 0.05, w: 0.96, h: 0.62, scale: 1.6 },
  { id: 'hand', x: 0.0, y: 0.68, w: 0.72, h: 0.3, scale: 2.4 },
  { id: 'self', x: 0.7, y: 0.66, w: 0.3, h: 0.34, scale: 3.0 },
];

/**
 * 手牌特写：牌名是手写体，OCR 基本认不出，所以额外裁一条放大图给模型看。
 * 上边界放到 0.60 是为了把「手牌张数/装备区」也框进来，下边界到 1.0 防止最右一张被切。
 */
const HAND_CROP = { x: 0.0, y: 0.6, w: 0.7, h: 0.4 } as const;

/** 与 src/ 同级的提示词模板；`{{...}}` 由 envPromptVars() 填充。 */
const ENV_PROMPT_FILE = fileURLToPath(new URL('../ENV_PROMPT.md', import.meta.url));

/**
 * 内置武将库走模块自身位置，不走 ctx.packageDir——
 * 宿主给的 packageDir 在 link 安装下不一定指向包根目录。
 */
const BUILTIN_GENERALS = fileURLToPath(new URL('../data/generals.json', import.meta.url));
/** 黑话库同理：随包分发，用户改动写 dataDir/slang-user.json。 */
const BUILTIN_SLANG = fileURLToPath(new URL('../data/slang.json', import.meta.url));

const GAME_LABEL: Record<string, string> = {
  sanguosha: '三国杀',
  generic: '游戏',
};

export interface GameBuddyOptions {
  cfg: GameBuddyConfig;
  dataDir: string;
  /** 包目录，用来定位随包分发的 data/generals.json。 */
  packageDir: string;
  /** 配置热改后可读的实时视图。 */
  live: () => GameBuddyConfig;
  /** 写回配置（面板开关用它持久化）。 */
  persist: (patch: Partial<GameBuddyConfig>) => void;
}

function minutes(ms: number): number {
  return Math.max(0, Math.round(ms / 60_000));
}

/** 画面年龄的说法：「刚刚」「0.8 秒前」「12 秒前」。 */
function ago(ms: number): string {
  if (ms < 900) return '刚刚';
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} 秒前`;
  return `${Math.round(ms / 1000)} 秒前`;
}

export class GameBuddyWorld implements World {
  readonly id = GAMEBUDDY_ID;
  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private armed = true;

  private active = false;
  private focused = false;
  private startedAt = 0;
  private lastCommentAt = 0;
  private comments = 0;
  private windows: WindowInfo[] = [];
  private foregroundPid = 0;
  private lastError: string | null = null;

  private lastState: BoardState | null = null;
  private lastStateAt = 0;
  private lastFrame: string | null = null;
  /** 最近一次读屏的完整回执文本与时间：宠物连着问两句时不必再截一遍。 */
  private lastReadText = '';
  private lastReadAt = 0;
  private lastReadSize = '';
  /** 最近一张手牌特写的路径：1.5 秒内复用缓存时连图一起复用 */
  private lastHandFile: string | null = null;
  /** 后台预读：只在前台打游戏时跑，把画面保持在 3 秒内 */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;
  private lastGenSaveAt = 0;
  private book: GeneralBook | null = null;
  private slang: SlangBook | null = null;
  private editor: EditorHandle | null = null;
  private lastGenerals: General[] = [];
  /** 直播采集：武将 sightings + 弹幕里的黑话候选 */
  private harvest: Harvest | null = null;
  private harvestTimer: ReturnType<typeof setInterval> | null = null;
  private harvestBusy = false;
  /** 最近一帧里出现的黑话，进环境提示词，让宠物说话时用对词。 */
  private lastSlang: SlangEntry[] = [];
  /** 自动补库失败过的名字与时间：10 分钟内不再重试，别让每次提问都卡在超时上。 */
  private learnMisses = new Map<string, number>();

  private readonly opts: GameBuddyOptions;

  constructor(opts: GameBuddyOptions) {
    this.opts = opts;
  }

  private cfg(): GameBuddyConfig {
    return { ...GAMEBUDDY_DEFAULTS, ...this.opts.live() };
  }

  /** 面板本地开关 + 配置值，任一说关就是关。 */
  private armedOn(): boolean {
    return this.armed && this.cfg().armed !== false;
  }

  /** 写回 worlds.gamebuddy.armed，重启后仍然记得。 */
  private saveArmed(value: boolean): void {
    try {
      this.opts.persist({ armed: value });
    } catch {
      /* 持久化失败只影响下次启动的默认值，不影响本次开关 */
    }
  }

  /** 武将库采集开关：默认开，面板上点一下关。 */
  private collectGeneralsOn(): boolean {
    return this.cfg().collectGenerals !== false;
  }

  /** 黑话库采集开关：默认开。 */
  private collectSlangOn(): boolean {
    return this.cfg().collectSlang !== false;
  }

  /** 写回采集开关，顺手把状态话术拼好给面板用。 */
  private saveCollect(kind: 'generals' | 'slang', value: boolean): void {
    try {
      this.opts.persist(kind === 'generals' ? { collectGenerals: value } : { collectSlang: value });
    } catch {
      /* 持久化失败不影响本次开关 */
    }
  }

  private collectText(): string {
    const g = this.collectGeneralsOn();
    const s = this.collectSlangOn();
    return `武将库采集：${g ? '开' : '关'}；黑话库采集：${s ? '开' : '关'}`;
  }

  private gameLabel(): string {
    return GAME_LABEL[this.cfg().game] ?? '游戏';
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.cfg();
    const status = !this.armedOn()
      ? '陪玩已关闭：不主动说话，也不读屏；主人打开开关前别做任何事'
      : this.active
        ? `在打《${this.gameLabel()}》，已陪 ${minutes(Date.now() - this.startedAt)} 分钟，本局主动搭话 ${this.comments}/${cfg.maxPerMatch}${this.focused ? '' : '，游戏不在前台'}`
        : `没在打《${this.gameLabel()}》`;
    return {
      'gamebuddy.status': status,
      'gamebuddy.state': this.lastState
        ? `${stateBrief(this.lastState)}\n（这行是 ${ago(Date.now() - this.lastStateAt)}的画面；超过 5 秒就先调 gamebuddy_look 再开口，别拿旧画面当现在）`
        : '还没有读到牌面',
      'gamebuddy.generals':
        this.lastGenerals.length > 0
          ? this.lastGenerals.map((g) => this.book?.brief(g) ?? g.name).join('\n')
          : '还没识别到场上的武将；问到不认识的武将时调 gamebuddy_general',
      'gamebuddy.slang':
        this.lastSlang.length > 0
          ? this.lastSlang.map((e) => this.slang?.brief(e) ?? e.term).join('\n')
          : '画面里还没认出黑话；主人用别称（如「狗货」「乐」）时调 gamebuddy_slang 查',
      'gamebuddy.editor': this.editor?.url ?? '编辑器没启动（worlds.gamebuddy.editor=false 或端口被占）',
      'gamebuddy.harvest': this.harvest
        ? this.harvestBrief()
        : '直播采集没开（worlds.gamebuddy.harvest=false）',
      'gamebuddy.tone':
        cfg.posture === 'coach' ? '教练口吻：短、准、先结论后理由。' : cfg.posture === 'quiet' ? '安静模式：只有主人问才说话。' : '毒舌吐槽：一句话，可以损但别阴阳怪气太久。',
    };
  }

  tools(): ToolDef[] {
    return [
      {
        name: 'gamebuddy_status',
        description:
          '读取陪玩搭子的当前状态：游戏有没有在跑、是否在前台、这局陪了多久、主动搭话了几次、有没有读到牌面。只读，不改变任何东西。',
        tags: ['game'],
        parameters: { type: 'object', properties: {} },
        handler: async () => this.statusText(),
      },
      {
        name: 'gamebuddy_look',
        description:
          '读一眼游戏画面，返回解析出的局势（身份/体力/手牌/阶段/认出的牌）。当你想根据画面吐槽或给建议、但不确定局势时调用。打游戏时插件每几秒后台预读一次，所以常常几十毫秒就返回；回执第一行写着画面多少秒前。识别不出来会明说，不要替它编。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            game: { type: 'string', description: '可选，忽略；保留给未来多游戏档位。' },
          },
        },
        handler: async () => (
          this.armedOn()
            ? this.lookText()
            : '[off] 陪玩已关闭：不读屏。想让她看，先打开宠物面板里的陪玩开关（或让主人说"打开陪玩"）。'
        ),
      },
      {
        name: 'gamebuddy_advise',
        description:
          '按三国杀规则给出这一回合的具体打法：身份目标、血线、出牌顺序、留牌。可以在 situation 里补一句现状（例如"我3血，手上杀闪桃，主公2血"），没读屏时尤其有用。返回的是可直接复述的要点，不要原样念给主人听。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            situation: { type: 'string', description: '主人说的当前局势，可为空。' },
            question: { type: 'string', description: '主人具体在纠结什么，可为空。' },
          },
        },
        handler: async (args) => (
          this.armedOn()
            ? this.adviseText(
                typeof args.situation === 'string' ? args.situation : undefined,
                typeof args.question === 'string' ? args.question : undefined,
              )
            : '[off] 陪玩已关闭：不接建议请求。想让她算，先打开陪玩开关。'
        ),
      },
      {
        name: 'gamebuddy_general',
        description:
          '查武将库，返回技能原文与简要打法。命中是本地毫秒级查询；库里没有时默认会自动联网（biligame 三国杀 wiki）抓一次并存入本地库，所以第一次可能慢一两秒、之后就是本地命中。不要自己回忆或搜索。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '武将名，如"简雍"、"界姜维"、"SP貂蝉"。' },
          },
          required: ['name'],
        },
        handler: async (args) => {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) return '[bad input] name 不能为空';
          return this.generalText(name);        },
      },
      {
        name: 'gamebuddy_slang',
        description:
          '查三国杀黑话库：武将别称（狗货=荀彧、二爷=关羽）、常见梗、术语和牌的简称（乐=乐不思蜀、过拆=过河拆桥）。主人用别称问事、或你读到的画面里有简称看不懂时调用。命中是本地毫秒级查询；也可能顺带返回该别称对应的武将技能。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            term: { type: 'string', description: '黑话/别称/简称，如"狗货"、"乐"、"过拆"、"跳反"。' },
          },
          required: ['term'],
        },
        handler: async (args) => {
          const term = typeof args.term === 'string' ? args.term.trim() : '';
          if (!term) return '[bad input] term 不能为空';
          return this.slangText(term);
        },
      },
      {
        name: 'gamebuddy_teach',
        description:
          '把一名武将的技能与打法写进本地库（下次查询就是毫秒级）。主人把技能描述发给你、或你在选将界面读到技能原文时调用。skills 是 [{name, text}] 数组；只想存一段原文时给 raw 即可。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '武将名。' },
            kingdom: { type: 'string', description: '势力：魏/蜀/吴/群，可空。' },
            hp: { type: 'number', description: '体力上限，可空。' },
            skills: {
              type: 'array',
              description: '技能列表。',
              items: {
                type: 'object',
                properties: { name: { type: 'string' }, text: { type: 'string' } },
                required: ['name', 'text'],
              },
            },
            raw: { type: 'string', description: '没有技能名时，把整段技能原文放这里。' },
            play: { type: 'string', description: '一句话打法，可空。' },
          },
          required: ['name'],
        },
        handler: async (args) => this.teachText(args),
      },
      {
        name: 'gamebuddy_slang_add',
        description:
          '把一条黑话写进本地黑话库（同一个词再写就覆盖）。主人说「这个记一下」、或你确认了新说法的意思时调用。term 是词条本名，aliases 是别名/别的写法（逗号分隔），meaning 是一句人话释义，usage 是用法/场合（可空），generals 是它指涉的武将名（逗号分隔，可空）。写完立即生效，不用重启。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            term: { type: 'string', description: '词条，如"二锅头"、"跳反"。' },
            meaning: { type: 'string', description: '一句人话释义，别抄词典腔。' },
            aliases: { type: 'string', description: '别名，逗号分隔，可空。' },
            usage: { type: 'string', description: '用法/场合一句话，可空。' },
            generals: { type: 'string', description: '指涉的武将名，逗号分隔，可空。' },
            kind: { type: 'string', description: 'nickname=武将别称 / meme=梗 / jargon=术语 / card=牌与装备。默认 jargon。' },
          },
          required: ['term', 'meaning'],
        },
        handler: async (args) => this.slangTeachText(args),
      },
      {
        name: 'gamebuddy_harvest',
        description:
          '看直播采集清单：最近对局里遇到的武将（哪些还没入库）、弹幕里冒出来但还没确认的黑话候选。主人问「最近记了些什么」「有新词吗」时调用；也可以拿来提醒主人去确认。只读。',
        tags: ['game'],
        parameters: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: '最多返回几条，默认 10。' },
          },
        },
        handler: async (args) => this.harvestText(typeof args.limit === 'number' ? args.limit : 10),
      },
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const zh = language !== 'en';
    const on = this.armedOn();
    return {
      label: zh ? '陪玩搭子' : 'Play-along buddy',
      lamps: [
        {
          label: zh ? '游戏' : 'Game',
          state: this.active ? 'online' : 'offline',
          hint: this.active ? this.biggest()?.title ?? '' : this.lastError ?? (zh ? '没检测到游戏窗口' : 'no game window'),
        },
        {
          label: zh ? '读屏' : 'Screen',
          state: this.cfg().ocr ? 'online' : 'offline',
          hint: this.cfg().ocr ? (this.lastFrame ?? '') : (zh ? 'OCR 已关闭' : 'OCR off'),
        },
        {
          label: zh ? '状态' : 'State',
          state: on ? (this.active ? 'online' : 'offline') : 'offline',
          hint: on ? '' : (zh ? '陪玩已关闭' : 'companion off'),
        },
      ],
      badges: [
        {
          label: zh ? '已陪' : 'Time',
          value: this.active ? `${minutes(Date.now() - this.startedAt)} min` : '—',
          tone: this.active ? 'on' : 'off',
        },
        {
          label: zh ? '搭话' : 'Comments',
          value: `${this.comments}/${this.cfg().maxPerMatch}`,
          tone: 'plain',
        },
        {
          label: zh ? '局势' : 'Board',
          value: this.lastState ? `${Math.round(this.lastState.confidence * 100)}%` : '—',
          tone: this.lastState ? 'on' : 'off',
        },
        {
          label: zh ? '库' : 'Books',
          value: `${this.book?.size ?? 0}武将+${this.slang?.size ?? 0}黑话`,
          tone: 'plain',
        },
      ],
      panels: [
        {
          id: PANEL,
          title: zh ? '陪玩搭子' : 'Play-along buddy',
          description: zh ? '看它在不在、读一眼牌面、叫它说句话。' : 'See whether it is watching, read the board, or ask for a line.',
        },
      ],
      invoke: async (panel, method, args) => {
        if (panel !== PANEL) throw new Error(`unknown panel ${panel}`);
        switch (method) {
          case 'status':
            return this.statusText();
          case 'look': {
            const looked = await this.lookText();
            return typeof looked === 'string' ? looked : looked.text;
          }
          case 'advise':
            return this.adviseText(
              typeof args?.[0] === 'string' ? (args[0] as string) : undefined,
              typeof args?.[1] === 'string' ? (args[1] as string) : undefined,
            );
          case 'state':
            return {
              armed: this.armedOn(),
              active: this.active,
              focused: this.focused,
              minutes: this.active ? minutes(Date.now() - this.startedAt) : 0,
              comments: this.comments,
              paused: !this.armedOn(),
              collectGenerals: this.collectGeneralsOn(),
              collectSlang: this.collectSlangOn(),
            };
          case 'collect':
            return {
              generals: this.collectGeneralsOn(),
              slang: this.collectSlangOn(),
              text: this.collectText(),
            };
          case 'setCollect': {
            const kind = args?.[0] === 'slang' ? 'slang' : args?.[0] === 'generals' ? 'generals' : null;
            if (kind === null) throw new Error('参数要是 generals 或 slang');
            this.saveCollect(kind, args?.[1] !== false && args?.[1] !== 'off');
            return {
              generals: this.collectGeneralsOn(),
              slang: this.collectSlangOn(),
              text: this.collectText(),
            };
          }
          case 'on':
          case 'resume':
            this.armed = true;
            this.saveArmed(true);
            return this.statusText();
          case 'off':
          case 'pause':
            this.armed = false;
            this.saveArmed(false);
            // 立刻清掉现场状态，面板不用等下一次扫描才变灰
            this.active = false;
            this.windows = [];
            return this.statusText();
          case 'comment': {
            if (!this.armedOn()) return '陪玩已关闭，先打开开关';
            if (!this.host) return 'host 还没就绪';
            this.pushTick(true);
            return '已让搭子开口';
          }
          case 'editor':
            return {
              url: this.editor?.url ?? '',
              generals: this.book?.size ?? 0,
              slang: this.slang?.size ?? 0,
            };
          case 'openEditor':
            return this.openEditorPage();
          case 'slang': {
            const term = typeof args?.[0] === 'string' ? (args[0] as string) : '';
            return this.slangText(term);
          }
          default:
            throw new Error(`unknown method ${method}`);
        }
      },
      config: [gamebuddyConfigGroup(language)],
      promptDocs: [
        {
          key: `worlds.${GAMEBUDDY_ID}.envPrompt`,
          title: zh ? '陪玩搭子 · 环境提示词' : 'Play-along buddy · env prompt',
          description: zh ? '什么时候该吐槽、什么时候该给打法，以及当前状态。' : 'When to roast, when to coach, and the live state.',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'gamebuddy.status', description: zh ? '游戏是否在跑、陪了多久、搭话次数。' : 'Whether the game runs, time played, comment count.' },
            { name: 'gamebuddy.state', description: zh ? '最近一次读到的局势。' : 'The most recent board reading.' },
            { name: 'gamebuddy.generals', description: zh ? '场上认出的武将及其技能要点（来自本地库）。' : 'Generals recognised on the board, with skill summaries from the local book.' },
            { name: 'gamebuddy.slang', description: zh ? '画面里认出的黑话/别称及释义（来自本地黑话库）。' : 'Slang and nicknames spotted on screen, from the local slang book.' },
            { name: 'gamebuddy.editor', description: zh ? '数据库编辑器地址，主人可以直接在浏览器里加条目。' : 'URL of the database editor where entries can be added in a browser.' },
            { name: 'gamebuddy.harvest', description: zh ? '直播采集攒下的武将数与黑话候选数。' : 'How many generals and slang candidates live harvesting has collected.' },
            { name: 'gamebuddy.tone', description: zh ? '当前语气档位。' : 'The current tone profile.' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.armed = this.cfg().armed !== false;
    this.active = false;
    this.focused = false;
    this.comments = 0;
    this.lastCommentAt = 0;
    this.lastState = null;
    this.lastError = null;
    try {
      this.book = new GeneralBook(BUILTIN_GENERALS, join(this.opts.dataDir, 'generals-user.json'));
      host.log.info(`武将库已加载：${this.book.size} 条（${BUILTIN_GENERALS}）`);
    } catch (error) {
      this.book = null;
      host.log.warn(`武将库加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      this.slang = new SlangBook(BUILTIN_SLANG, join(this.opts.dataDir, 'slang-user.json'));
      host.log.info(`黑话库已加载：${this.slang.size} 条（内置 ${this.slang.builtinSize}，${BUILTIN_SLANG}）`);
    } catch (error) {
      this.slang = null;
      host.log.warn(`黑话库加载失败：${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      mkdirSync(join(this.opts.dataDir, 'frames'), { recursive: true });
      // 只留最近 20 张显式截图；老版本留下的 r-* 裁切目录也一并清掉
      const dir = join(this.opts.dataDir, 'frames');
      for (const entry of readdirSync(dir)) {
        if (entry.startsWith('r-')) {
          try {
            rmSync(join(dir, entry), { recursive: true, force: true });
          } catch {
            /* 删不掉就算了 */
          }
        }
      }
      const shots = readdirSync(dir).filter((f) => f.startsWith('look-') && f.endsWith('.jpg')).sort();
      for (const stale of shots.slice(0, Math.max(0, shots.length - 20))) {
        try {
          unlinkSync(join(dir, stale));
        } catch {
          /* 删不掉就算了 */
        }
      }
    } catch {
      /* 目录建不出来时截图会失败，但不该拦住世界启动 */
    }
    const cfg = this.cfg();
    // 直播采集：读直播间事件流，记武将、攒黑话候选。没有直播也不报错，只是空转。
    if (cfg.harvest !== false) {
      try {
        this.harvest = new Harvest(join(this.opts.dataDir, 'harvest.json'), {
          knownSlang: (term) => Boolean(this.slang?.get(term)),
          detectSlang: (text) => (this.slang?.detect(text) ?? []).map((entry) => entry.term),
          detectGenerals: (text) => (this.book?.detect(text) ?? []).map((general) => general.name),
          knownGeneral: (name) => Boolean(this.book?.lookup(name)),
        });
        const stats = this.harvest.stats();
        host.log.info(`直播采集已加载：武将 ${stats.generals} 条、黑话候选 ${stats.candidates} 条、最近弹幕 ${stats.danmaku} 条`);
        const everyHarvest = Math.max(5, Math.round(cfg.harvestSec || 15)) * 1000;
        this.harvestTimer = setInterval(() => {
          void this.pollHarvest();
        }, everyHarvest);
        this.harvestTimer.unref?.();
        void this.pollHarvest();
      } catch (error) {
        this.harvest = null;
        host.log.warn(`直播采集初始化失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 编辑器页面：改库用的小网页，只监听 127.0.0.1；起不来不影响陪玩
    if (cfg.editor !== false && this.book && this.slang) {
      try {
        this.editor = await startEditor({
          port: Math.max(1024, Math.round(Number(cfg.editorPort) || 17790)),
          generals: this.book,
          slang: this.slang,
          harvest: this.harvest ?? undefined,
          learnGeneral: (name) => this.learnByWeb(name),
          log: host.log,
        });
      } catch (error) {
        this.editor = null;
        host.log.warn(`数据库编辑器启动失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const every = Math.max(3, Math.round(cfg.pollSec || 8)) * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, every);
    this.timer.unref?.();
    // 后台预读：真在打游戏时把画面一直焐热，宠物问的时候不用等截图+OCR
    const refreshSec = Math.max(0, Math.round(Number(cfg.refreshSec ?? 3)));
    if (refreshSec > 0 && cfg.ocr !== false) {
      this.refreshTimer = setInterval(() => {
        void this.preload();
      }, refreshSec * 1000);
      this.refreshTimer.unref?.();
    }
    host.log.info(`陪玩搭子已启动，每 ${every / 1000}s 扫一次窗口：${cfg.windowPattern}${refreshSec > 0 ? `；画面每 ${refreshSec}s 预读一次` : ''}`);
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.harvestTimer) {
      clearInterval(this.harvestTimer);
      this.harvestTimer = null;
    }
    try {
      this.harvest?.endSession();
      this.harvest?.save(true);
    } catch {
      /* 收尾失败不影响世界停止 */
    }
    this.harvest = null;
    if (this.editor) {
      const editor = this.editor;
      this.editor = null;
      try {
        await editor.close();
      } catch {
        /* 关不掉也不该拦住世界停止 */
      }
    }
    this.host = null;
    this.active = false;
  }

  // ---------------------------------------------------------------- 观测

  /**
   * 后台预读：真在打游戏时每 refreshSec 秒读一帧，把缓存焐热，
   * 宠物问「该出什么」时直接命中缓存（几十毫秒），而不是现场截图+OCR（1.2 秒起）。
   * 游戏不在前台就不烧这一次 OCR。
   */
  private async preload(): Promise<void> {
    if (this.refreshing || this.host === null || !this.armedOn()) return;
    if (this.cfg().ocr === false) return;
    // focused 由 tick 维护：游戏在前台才预热，否则这次 OCR 纯属浪费
    if (!this.focused) return;
    this.refreshing = true;
    try {
      await this.lookText(true, false);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.refreshing = false;
    }
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!this.armedOn()) {
        // 关着的时候连窗口都不扫：不占 CPU，也不给宠物任何可发挥的由头
        this.active = false;
        this.windows = [];
        this.lastError = null;
        return;
      }
      const cfg = this.cfg();
      const det = await detect(cfg.windowPattern);
      if (!det.ok) {
        this.lastError = det.error ?? '窗口探测失败';
        return;
      }
      this.lastError = null;
      this.foregroundPid = det.foregroundPid;
      this.windows = det.windows.filter((w) => w.hwnd !== 0);
      const active = this.windows.length > 0;
      const focused = this.windows.some((w) => w.pid === det.foregroundPid);
      const wasActive = this.active;
      this.focused = focused;

      if (active && !wasActive) {
        this.active = true;
        this.startedAt = Date.now();
        this.comments = 0;
        this.lastCommentAt = Date.now();
        this.harvest?.beginSession();
        const main = this.biggest();
        this.push(
          `${this.gameLabel()}上号了` +
            `（${main?.process ?? '?'}：${(main?.title ?? '').slice(0, 40)}）。` +
            `刚开始这一局，先安静看两分钟，别急着点评；等真打起来再开口。`,
          'start',
        );
      } else if (!active && wasActive) {
        const mins = minutes(Date.now() - this.startedAt);
        this.active = false;
        const session = this.harvest?.endSession();
        const seen = session && session.generals.length > 0 ? `这局遇到 ${session.generals.join('、')}` : '';
        const fresh = session && session.newSlang > 0 ? `弹幕里攒了 ${session.newSlang} 个新说法` : '';
        const tail = [seen, fresh].filter((part) => part !== '').join('，');
        this.push(
          `这局收了，陪了 ${mins} 分钟、主动搭话 ${this.comments} 次。` +
            (tail ? `${tail}（都在编辑器「采集」页等你确认）。` : '') +
            '可以说句收尾的话，不想说就别说。',
          'end',
        );
        this.harvest?.save();
        return;
      }

      if (!active || this.paused) return;
      if (cfg.quietOnBlur && !focused) return;
      if (this.comments >= cfg.maxPerMatch) return;
      const gap = Math.max(30, cfg.commentEverySec || 150) * 1000;
      if (Date.now() - this.lastCommentAt < gap) return;
      this.pushTick(false);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }

  /** 主动搭话：把"该说什么"的事实交给宿主，让主人的宠物用自己的嘴说出来。 */
  private pushTick(force: boolean): void {
    const cfg = this.cfg();
    this.lastCommentAt = Date.now();
    this.comments += 1;
    const mins = minutes(Date.now() - this.startedAt);
    const stateLine = this.lastState
      ? `刚读到的牌面：${stateBrief(this.lastState)}。`
      : '还没读牌面，你不知道具体手牌。';
    const tone =
      cfg.posture === 'coach'
        ? '用一句话点出这回合最该做的一件事，别展开。'
        : '用一句话吐槽这局势，毒舌一点，但别连着骂。';
    this.push(
      `陪玩提醒（第 ${this.comments} 次${force ? '，主人点名要你说' : ''}）：已陪 ${mins} 分钟。${stateLine}` +
        `${tone}没把握就说没把握，或者调 gamebuddy_look 看一眼；不想说可以只回一个表情。`,
      'tick',
    );
  }

  private push(text: string, kind: 'start' | 'end' | 'tick'): void {
    const host = this.host;
    if (!host) return;
    void host
      .pushEvent(
        {
          type: `${GAMEBUDDY_ID}.${kind}`,
          source: GAMEBUDDY_ID,
          ts: new Date().toISOString(),
          text,
          meta: { kind, comments: this.comments, minutes: minutes(Date.now() - this.startedAt) },
        },
        { trigger: 'flush' },
      )
      .catch((error) => host.log.warn(`搭子事件投递失败：${String(error)}`));
  }

  // ---------------------------------------------------------------- 直播采集

  /**
   * 从事件库里捞直播弹幕：直播间里说过的黑话、提到的武将都记下来。
   * 只读游标之后的新事件，读到哪存到哪，重启不会重扫。
   */
  private async pollHarvest(): Promise<void> {
    const host = this.host;
    const harvest = this.harvest;
    if (!host || !harvest || this.harvestBusy || !this.armedOn()) return;
    this.harvestBusy = true;
    try {
      const store = host.store;
      if (!store) return;
      const latest = store.latestCursor();
      if (latest <= harvest.cursor) return;
      const events = store.range({ fromCursor: harvest.cursor + 1, toCursor: latest, limit: 500 });
      // 黑话采集关掉时，游标照样往前走（别攒下一次的洪水），只是不记词
      const wantSlang = this.collectSlangOn();
      const wantGenerals = this.collectGeneralsOn();
      let fresh = 0;
      let maxCursor = harvest.cursor;
      for (const event of events) {
        if (event.cursor > maxCursor) maxCursor = event.cursor;
        if (!wantSlang && !wantGenerals) continue;
        if (event.type !== 'bilibili.danmaku') continue;
        const meta = (event.meta ?? {}) as { body?: unknown; uname?: unknown };
        const body = typeof meta.body === 'string'
          ? meta.body
          : event.text.replace(/^\[弹幕\|[^\]]*\]\s*/u, '');
        const user = typeof meta.uname === 'string' ? meta.uname : '';
        if (harvest.noteDanmaku(body, user, { slang: wantSlang, generals: wantGenerals })) fresh += 1;
      }
      harvest.cursor = maxCursor;
      if (fresh > 0) harvest.save();

      // 同一个词被提了好几次：问主人一句，问过就不再刷
      const nudge = harvest.nextNudge();
      if (nudge) {
        harvest.markNudged(nudge.term);
        this.pushHarvest(nudge);
      }
      await this.learnMissingGeneral(harvest);
    } catch (error) {
      host.log.warn(`直播采集失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.harvestBusy = false;
    }
  }

  /** 采集到的武将里挑一个还没入库的，联网补一次（每轮最多一个，失败冷却 10 分钟）。 */
  private async learnMissingGeneral(harvest: Harvest): Promise<void> {
    if (this.cfg().autoLearn === false) return;
    if (!this.collectGeneralsOn()) return;
    const missing = harvest.generalHits(20).find((hit) => !hit.learned);
    if (!missing) return;
    const lastFail = this.learnMisses.get(missing.name) ?? 0;
    if (Date.now() - lastFail < 10 * 60_000) return;
    const learned = await this.learnByWeb(missing.name);
    if (learned) {
      harvest.markLearned(missing.name);
      harvest.save();
    } else {
      this.learnMisses.set(missing.name, Date.now());
    }
  }

  /** 把「弹幕里反复出现的词」交给宠物，让它去问主人。 */
  private pushHarvest(hit: SlangHit): void {
    const host = this.host;
    if (!host) return;
    const sample = hit.samples[hit.samples.length - 1] ?? '';
    void host
      .pushEvent(
        {
          type: `${GAMEBUDDY_ID}.harvest`,
          source: GAMEBUDDY_ID,
          ts: new Date().toISOString(),
          text:
            `直播弹幕里已经出现 ${hit.count} 次「${hit.term}」${sample ? `，例句「${sample.slice(0, 30)}」` : ''}。` +
            `你要是认得就一句话解释它是什么意思；不认识就直接问主人（别猜），确认后会进黑话库。`,
          meta: { term: hit.term, count: hit.count },
        },
        { trigger: 'debounce' },
      )
      .catch((error) => host.log.warn(`采集提醒投递失败：${String(error)}`));
  }

  // ---------------------------------------------------------------- 工具

  private statusText(): string {
    const cfg = this.cfg();
    const lines = [
      `陪玩开关：${this.armedOn() ? '开启' : '已关闭（不搭话、不读屏）'}`,
      `游戏：${this.active ? `《${this.gameLabel()}》在跑` : '没检测到'}`,
      this.biggest() ? `窗口：${this.biggest()!.title}（${this.biggest()!.process}，pid ${this.biggest()!.pid}）` : '窗口：—',
      `前台：${this.focused ? '是' : '否'}`,
      this.active
        ? `本局：已陪 ${minutes(Date.now() - this.startedAt)} 分钟，主动搭话 ${this.comments}/${cfg.maxPerMatch}`
        : '本局：—',
      `读屏：${cfg.ocr ? '开' : '关'}${this.lastFrame ? `，最近截图 ${this.lastFrame}` : ''}${this.lastReadAt ? `，画面 ${ago(Date.now() - this.lastReadAt)}` : ''}`,
      `武将库：${this.book?.size ?? 0} 条${this.lastGenerals.length ? `，本局认出 ${this.lastGenerals.map((g) => g.name).join('、')}` : ''}`,
      this.harvest ? `直播采集：${this.harvestBrief()}` : '直播采集：关',
      `库采集：${this.collectText()}`,
      `局势：${this.lastState ? stateBrief(this.lastState) : '还没有读到'}`,
      this.lastError ? `最近错误：${this.lastError}` : '',
    ].filter((l) => l !== '');
    return lines.join('\n');
  }

  /**
   * 同一进程往往同时有主窗口和一个 360×169 的通知小窗（模拟器尤其如此），
   * 按面积挑最大的那块才是真正的游戏画面。
   */  /** 采集状态一行摘要（给 statusText 和环境提示词用） */
  private harvestBrief(): string {
    const harvest = this.harvest;
    if (!harvest) return '没开';
    const stats = harvest.stats();
    const pending = harvest.candidates(200).length;
    return `武将 ${stats.generals} 位、黑话候选 ${pending} 条、弹幕 ${stats.danmaku} 条`;
  }

  private harvestText(limit = 10): string {
    const harvest = this.harvest;
    if (!harvest) return '[off] 直播采集没开（worlds.gamebuddy.harvest=false）。';
    const stats = harvest.stats();
    const generals = harvest.generalHits(limit);
    const candidates = harvest.candidates(limit);
    const lines = [
      `[harvest] 武将 ${stats.generals} 位（其中 ${generals.filter((g) => !g.learned).length} 位还没入库）` +
        `· 黑话候选 ${stats.candidates} 条 · 最近弹幕 ${stats.danmaku} 条 · 直播 ${stats.sessions} 场`,
    ];
    if (generals.length > 0) {
      lines.push(
        '武将：' + generals.map((g) => `${g.name}×${g.count}${g.learned ? '' : '(未入库)'}`).join('、'),
      );
    }
    if (candidates.length > 0) {
      lines.push('黑话候选：' + candidates.map((c) => `${c.term}×${c.count}`).join('、'));
    }
    if (generals.length === 0 && candidates.length === 0) {
      lines.push('清单还是空的：开局读一次画面就会记武将，直播弹幕里说到的新词会攒到这里。');
    }
    lines.push(
      this.editor
        ? `确认和补库在 ${this.editor.url} 的「采集」页（只在本机）。`
        : '编辑器没开；要直接看得改 dataDir 里的 harvest.json。',
    );
    return lines.join('\n');
  }

  private biggest(): WindowInfo | null {
    const sorted = [...this.windows].sort((a, b) => (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0));
    return sorted[0] ?? null;
  }

  private async generalText(name: string): Promise<string> {
    const book = this.book;
    if (!book) {
      return '[book] 武将库没加载成功（看 Coopanion 日志里的「武将库加载失败」）。先用 gamebuddy_look 读画面上的技能描述。';
    }
    const hit = book.lookup(name);
    if (hit) {
      const note = hit.name !== name.trim() ? `（按「${name}」匹配到「${hit.name}」）` : '';
      return `[general]${note}\n${book.format(hit)}`;
    }

    // 先问黑话库：主人可能用别称（「狗货」「二爷」）而不是武将本名
    const slangHit = this.slang?.lookup(name);
    if (slangHit?.generals?.length) {
      for (const alias of slangHit.generals) {
        const general = book.lookup(alias);
        if (general) {
          return `[slang] 「${name}」是黑话（${slangHit.meaning}），指 ${slangHit.generals.join('、')}。\n${book.format(general)}`;
        }
      }
    }

    const cfg = this.cfg();
    if (cfg.autoLearn !== false) {
      const key = name.trim();
      const lastFail = this.learnMisses.get(key) ?? 0;
      if (Date.now() - lastFail > 10 * 60_000) {
        const learned = await this.learnByWeb(key);
        if (learned) {
          const via = learned.source?.replace(/^web\s*/u, '') ?? 'wiki';
          return `[learned] 本地库原本没有「${key}」，已自动从 ${via} 抓好并存入（现 ${book.size} 条），下次起本地命中、不用再联网。\n${book.format(learned)}\n[source] ${learned.source ?? 'web'}`;
        }
        this.learnMisses.set(key, Date.now());
      }
    }

    return `[miss] 本地库没有「${name}」（现有 ${book.size} 条），自动抓取也没成功。\n`
      + '可以让主人把技能原文发给你，然后调 gamebuddy_teach 存进去；或稍后再试（网络不通时抓不到）。\n'
      + '不要凭印象编技能。';
  }

  /** 联网抓一次并写库；失败返回 null，不抛错。 */
  private async learnByWeb(name: string): Promise<General | null> {
    const book = this.book;
    if (!book) return null;
    try {
      const cfg = this.cfg();
      // auto = 默认顺序；指定了某个源就让它排第一，其余照旧兜底。
      const pref = typeof cfg.wikiSource === 'string' ? cfg.wikiSource : 'auto';
      const order = pref && pref !== 'auto' && WIKI_SOURCE_IDS.includes(pref)
        ? [pref, ...WIKI_SOURCE_IDS.filter((id) => id !== pref)]
        : undefined;
      const fetched = await fetchGeneral(name, 9000, { sources: order });
      if (!fetched) return null;
      const saved = book.teach({
        name: fetched.name || name,
        kingdom: fetched.kingdom,
        hp: fetched.hp,
        skills: fetched.skills,
        source: `web ${fetched.sourceUrl}`,
      });
      this.host?.log.info(
        `自动补库：${saved.name}（${fetched.skills.length} 技能，来自 ${fetched.sourceLabel ?? fetched.sourceId ?? 'wiki'}：${fetched.sourceUrl}）`,
      );
      return saved;
    } catch (error) {
      this.host?.log.warn(`自动补库失败 ${name}：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 查黑话；命中且指涉武将时，顺手把武将技能也带上。 */
  private slangText(term: string): string {
    const book = this.slang;
    if (!book) return '[slang] 黑话库没加载成功（看日志里的「黑话库加载失败」）。';
    const hit = book.lookup(term);
    if (!hit) {
      const near = book
        .list()
        .filter((e) => e.term.includes(term) || term.includes(e.term))
        .slice(0, 5);
      const tail = near.length > 0 ? `\n相近：${near.map((e) => `${e.term}（${e.meaning}）`).join('；')}` : '';
      const where = this.editor?.url ?? '（编辑器没启动）';
      return `[miss] 黑话库里没有「${term}」（现有 ${book.size} 条）。${tail}\n想加一条就在编辑器页面里写：${where}`;
    }
    const lines = [`[slang] ${book.format(hit)}`];
    for (const name of hit.generals ?? []) {
      const general = this.book?.lookup(name);
      if (general) lines.push(`[general] ${this.book?.brief(general)}`);
    }
    return lines.join('\n');
  }

  /** 写一条黑话进库（同名词条覆盖），写完整库立即生效。 */
  private slangTeachText(args: Record<string, unknown>): string {
    const book = this.slang;
    if (!book) return '[slang] 黑话库没加载，写入失败。';
    const term = typeof args.term === 'string' ? args.term.trim() : '';
    const meaning = typeof args.meaning === 'string' ? args.meaning.trim() : '';
    if (!term) return '[bad input] term 不能为空';
    if (!meaning) return '[bad input] meaning 不能为空，一句话解释就行';
    const listOf = (value: unknown): string[] =>
      typeof value === 'string'
        ? value
            .split(/[,，、\s]+/u)
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const kinds: SlangKind[] = ['nickname', 'meme', 'jargon', 'card'];
    const kindArg = typeof args.kind === 'string' ? args.kind.trim() : '';
    const kind = (kinds.includes(kindArg as SlangKind) ? kindArg : 'jargon') as SlangKind;
    // usage 和 note 是同一个位置：主人习惯说「用法」，老调用方传 note，两个都收
    const usageRaw = typeof args.usage === 'string' ? args.usage.trim() : '';
    const noteRaw = typeof args.note === 'string' ? args.note.trim() : '';
    const entry = book.teach({
      term,
      kind,
      meaning,
      aliases: listOf(args.aliases),
      generals: listOf(args.generals),
      note: usageRaw || noteRaw || undefined,
      source: 'pet',
    });
    return [`[taught] ${book.format(entry)}`, `黑话库现在 ${book.size} 条，已生效（不用重启）。`].join('\n');
  }

  /** 用系统默认浏览器打开编辑器页面（面板按钮也能用）。 */
  private openEditorPage(): string {
    const url = this.editor?.url;
    if (!url) return '编辑器没启动（worlds.gamebuddy.editor 关着，或者端口都被占了）。';
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      return `已用默认浏览器打开 ${url}`;
    } catch (error) {
      return `自动打开失败（${error instanceof Error ? error.message : String(error)}），手动复制这个地址：${url}`;
    }
  }

  private teachText(args: Record<string, unknown>): string {
    const book = this.book;
    if (!book) return '[book] 武将库没加载，写入失败。';
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return '[bad input] name 不能为空';

    const skills: GeneralSkill[] = [];
    if (Array.isArray(args.skills)) {
      for (const raw of args.skills) {
        if (!raw || typeof raw !== 'object') continue;
        const skill = raw as { name?: unknown; text?: unknown };
        if (typeof skill.name === 'string' && typeof skill.text === 'string' && skill.name.trim() && skill.text.trim()) {
          skills.push({ name: skill.name.trim(), text: skill.text.trim() });
        }
      }
    }
    const rawText = typeof args.raw === 'string' ? args.raw.trim() : '';
    if (skills.length === 0 && rawText) skills.push({ name: '技能', text: rawText });
    if (skills.length === 0) return '[bad input] 需要 skills 或 raw 至少一个';

    const saved = book.teach({
      name,
      skills,
      kingdom: typeof args.kingdom === 'string' ? args.kingdom.trim() : undefined,
      hp: typeof args.hp === 'number' ? args.hp : undefined,
      play: typeof args.play === 'string' ? args.play.trim() : undefined,
      source: 'user',
    });
    return `[saved] ${saved.name} 已写入本地库（现有 ${book.size} 条），下次查询直接命中。\n${book.format(saved)}`;
  }

  /**
   * 读一帧。
   * - `force=false` 且缓存不到 1.5 秒：直接复用上一帧（宠物常连着问两句，别截两遍）。
   * - `withImage=false`：后台预读用，不读 JPEG 字节、不挂附件。
   */
  private async lookText(force = false, withImage = true): Promise<string | { text: string; blobs: unknown[] }> {
    const cfg = this.cfg();
    if (!cfg.ocr) return '[screen] 读屏被关掉了（worlds.gamebuddy.ocr=false），只能靠主人告诉你局势。';
    const cachedAge = Date.now() - this.lastReadAt;
    if (!force && this.lastReadText !== '' && cachedAge < 1500) {
      return this.wrapImage(
        `[screen] 复用 ${ago(cachedAge)}的那一帧（不重复截图）\n${this.lastReadText}`,
        this.lastFrame,
        this.lastReadSize,
        withImage,
        this.lastHandFile ? [this.lastHandFile] : [],
      );
    }
    if (this.windows.length === 0) {
      const det = await detect(cfg.windowPattern);
      this.windows = det.windows.filter((w) => w.hwnd !== 0);
      this.foregroundPid = det.foregroundPid;
    }
    const target = this.biggest();
    if (!target) return '[screen] 没找到游戏窗口，读不到。可以让主人确认游戏开着，或直接口述局势。';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    // JPEG 而不是 PNG：一张 1534×881 的图 PNG 近 2MB，JPEG 约 200KB，模型侧更划算
    // 预读用固定文件名反复覆盖，别每 3 秒在 frames 里堆一张 200KB 的图
    const out = join(this.opts.dataDir, 'frames', withImage ? `look-${stamp}.jpg` : 'live.jpg');
    // 游戏被别的窗口挡住时先置前；它已经是前台就不抢焦点
    const focus = target.pid !== this.foregroundPid;
    let shot = await captureWindow(target.hwnd, out, { focus });
    if (shot.ok && shot.occluded) {
      // 被挡的时候第一次经常抓到叠影：等一下、强抢一次前台，再截一遍
      await new Promise((resolve) => setTimeout(resolve, 250));
      const again = await captureWindow(target.hwnd, out, { focus: true });
      if (again.ok) shot = again;
    }
    if (!shot.ok) {
      this.lastError = shot.error ?? '截图失败';
      return `[screen] 截图失败：${this.lastError}。可以让主人切到游戏窗口再试，或口述局势。`;
    }
    this.lastFrame = out;

    if (cfg.regionOcr !== false) {
      const read = await ocrRegions(out, SANGUOSHA_REGIONS, join(this.opts.dataDir, 'frames', 'regions'), cfg.ocrLanguage);
      if (read.ok && read.regions.some((r) => r.lines.length > 0)) {
        const state = parseRegions(read.regions);
        this.lastState = state;
        this.lastStateAt = Date.now();
        // 顺手把画面里认得出的武将查一遍本地库：查完直接进上下文，问技能时零额外往返
        const flatText = read.regions.map((r) => r.lines.join('')).join('');
        this.lastGenerals = this.book?.detect(flatText) ?? [];
        this.noteScreenGenerals();
        const generalLines = this.lastGenerals.map((g) => `[general] ${this.book?.brief(g) ?? g.name}`);
        this.lastSlang = this.slang?.detect(flatText) ?? [];
        const slangLines = this.lastSlang.map((e) => `[slang] ${this.slang?.brief(e) ?? e.term}`);
        const raw = read.regions
          .filter((r) => r.lines.length > 0)
          .map((r) => `[${r.id}] ${r.lines.join(' / ')}`)
          .join('\n');
        const handFile = await this.handFocus(out);
        this.lastHandFile = handFile;
        const text = [
          `[screen] 已读 ${shot.size ?? '?'}，分 ${read.regions.length} 区（刚读的）`,
          shot.occluded ? '[warn] 截图时游戏不在最前，画面可能被别的窗口盖着；这张图别当准。' : '',
          `[board] ${stateBrief(state)}`,
          state.handCards.length > 0
            ? `[hand] 认出 ${state.handCards.length} 张：${state.handCards.join('、')}（只认得出带字的牌，单字牌可能漏；不确定就看第二张图）`
            : handFile
              ? '[hand] 手牌区 OCR 没认出牌名——看第二张图（手牌特写），牌名以图为准。'
              : '[hand] 手牌区没认出牌名（可以问主人手上有什么）',
          state.counts ? `[counts] ${state.counts}` : '',
          state.objective ? `[goal] ${state.objective}` : '',
          ...generalLines,
          ...slangLines,
          raw,
          state.confidence < 0.4
            ? '[note] 置信度低：认出的只当线索，别当准数；拿不准就问主人。'
            : '[note] 用这些事实说话，别复述整段。',
        ]
          .filter((line) => line !== '')
          .join('\n');
        const handNote = handFile
          ? '[hand-shot] 第二张图是手牌特写（放大 2 倍）：数牌、认牌面都看它，别硬猜 OCR 出的字。'
          : '';
        return this.remember(
          handNote ? `${text}\n${handNote}` : text,
          out,
          shot.size,
          withImage,
          handFile ? [handFile] : [],
        );
      }
    }

    const read = await ocrImage(out, cfg.ocrLanguage);
    if (!read.ok || read.lines.length === 0) {
      this.lastError = read.error ?? 'OCR 没读出字';
      return `[screen] 截到了 ${shot.size ?? '?'}，但 OCR 没读出文字（${this.lastError}）。可以口述局势，或调 gamebuddy_advise 传 situation。`;
    }
    const state = parseBoard(read.lines);
    this.lastState = state;
    this.lastStateAt = Date.now();
    const flat = read.lines.join('');
    this.lastGenerals = this.book?.detect(flat) ?? [];
    this.noteScreenGenerals();
    this.lastSlang = this.slang?.detect(flat) ?? [];
    const sample = read.lines.slice(0, 24).join(' / ');
    const handFile = await this.handFocus(out);
    this.lastHandFile = handFile;
    const text = [
      `[screen] 已读 ${shot.size ?? '?'}，${read.lines.length} 行文字。`,
      `[board] ${stateBrief(state)}`,
      `[text] ${sample}`,
      handFile ? '[hand-shot] 另附第二张图：手牌特写（放大 2 倍），看不清文字就看图。' : '',
      state.confidence < 0.4
        ? '[note] 置信度低，别把上面的字段当准数；拿不准就先问主人，或让他口述。'
        : '[note] 用这些事实说话，别复述整段。',
    ]
      .filter((line) => line !== '')
      .join('\n');
    return this.remember(text, out, shot.size, withImage, handFile ? [handFile] : []);
  }

  /**
   * 手牌特写：牌面是手写体，OCR 基本认不出，所以把底下那一条裁出来放大 2 倍、
   * 用高质量 JPEG 存成第二张图直接给模型看——这是「看不清牌」最有效的解法。
   */
  private async handFocus(frame: string): Promise<string | null> {
    const file = join(this.opts.dataDir, 'frames', 'hand-focus.jpg');
    const out = await cropImage(frame, file, HAND_CROP, 2, 92);
    return out.ok ? file : null;
  }

  /** 读屏认出的武将顺手记进采集清单：同一局反复读只累加次数，不重复写文件 */
  private noteScreenGenerals(): void {
    if (!this.harvest || this.lastGenerals.length === 0) return;
    if (!this.collectGeneralsOn()) return;
    for (const general of this.lastGenerals) this.harvest.noteGeneral(general.name, 'screen');
    // 后台每 3 秒读一帧，别每次都落盘；15 秒内攒着一起写
    if (Date.now() - this.lastGenSaveAt < 15_000) return;
    this.harvest.save();
    this.lastGenSaveAt = Date.now();
  }

  /**
   * 记下这一帧的回执：1.5 秒内宠物再问，直接复用，不再截图。
   */
  private remember(
    text: string,
    file: string,
    size: string | undefined,
    want: boolean,
    extra: string[] = [],
  ): string | { text: string; blobs: unknown[] } {
    this.lastReadText = text;
    this.lastReadAt = Date.now();
    this.lastReadSize = size ?? '';
    return this.wrapImage(text, file, size, want, extra);
  }

  private wrapImage(
    text: string,
    file: string | null,
    size: string | undefined,
    want: boolean,
    extra: string[] = [],
  ): string | { text: string; blobs: unknown[] } {
    if (!want || file === null) return text;
    return this.withImage(text, file, size, extra);
  }

  /**
   * 把这一帧作为图片附件挂到工具回执上：模型的 provider 接受 image/jpeg 就直接看图，
   * 不接受就只收到 fallbackText，等于退回纯文字。
   */
  private withImage(text: string, file: string, size?: string, extra: string[] = []): string | { text: string; blobs: unknown[] } {
    const cfg = this.cfg();
    if (cfg.sendImage === false) return text;
    const items: { file: string; name: string; label: string }[] = [
      { file, name: 'sanguosha.jpg', label: `三国杀对局截图 ${size ?? ''}`.trim() },
      ...extra.map((f, i) => ({
        file: f,
        name: `sanguosha-hand-${i + 1}.jpg`,
        label: '三国杀手牌特写：放大后的手牌与装备，牌名以这张为准',
      })),
    ];
    const blobs: { bytes: Uint8Array; mime: string; name: string; fallbackText: string }[] = [];
    for (const item of items) {
      try {
        const bytes = readFileSync(item.file);
        if (bytes.byteLength > 0) blobs.push({ bytes, mime: 'image/jpeg', name: item.name, fallbackText: item.label });
      } catch {
        /* 单张图读不到就少挂一张，别让整条回执失败 */
      }
    }
    if (blobs.length === 0) return text;
    return { text, blobs };
  }

  private adviseText(situation?: string, question?: string): string {
    const cfg = this.cfg();
    if (cfg.game !== 'sanguosha') {
      return '[generic] 当前是 generic 档位，没有内置规则引擎。直接按主人描述的局面回答，别假装会算牌。';
    }
    const fresh = this.lastState && Date.now() - this.lastStateAt < 5 * 60_000 ? this.lastState : null;
    const fromText = situation ? parseBoard([situation]) : null;
    const merged: BoardState = {
      ...(fresh ?? { cards: [], hazards: [], lines: [], confidence: 0, identitiesSeen: [] }),
      ...(fromText && fromText.confidence > 0 ? fromText : {}),
      cards: [...new Set([...(fresh?.cards ?? []), ...(fromText?.cards ?? [])])],
      hazards: [...new Set([...(fresh?.hazards ?? []), ...(fromText?.hazards ?? [])])],
      lines: [...(fresh?.lines ?? []), ...(fromText?.lines ?? [])].slice(0, 60),
    };
    if (merged.identity === undefined && merged.hp === undefined && merged.cards.length === 0) {
      return '[no state] 还没有读到牌面，也没给 situation。先请主人用一句话说：身份、血量、手上有什么，然后我再给打法。';
    }
    const advice = advise(merged, question, cfg.posture);
    const ageLine =
      fresh === null
        ? (situation ? '' : '[note] 这局还没读过画面，结论只基于主人口述。')
        : Date.now() - this.lastStateAt > 5000
          ? `[note] 牌面是 ${ago(Date.now() - this.lastStateAt)}的——先 gamebuddy_look 看一眼再念，局势可能变了。`
          : `[note] 牌面 ${ago(Date.now() - this.lastStateAt)}，新鲜。`;
    return `[advice]\n${renderAdvice(advice)}${ageLine ? `\n${ageLine}` : ''}\n[note] 这是规则层的结论，用你自己的话说给主人听，别原样念。`;
  }
}
