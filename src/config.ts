import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export interface GameBuddyConfig {
  [key: string]: unknown;
  /** 整个搭子包的总开关，框架读这个决定要不要挂载。 */
  enabled: boolean;
  /** 陪玩开关：关掉后不主动搭话、不读屏，工具也直接拒绝。面板上的开关会写这里。 */
  armed: boolean;
  /** 游戏档位：sanguosha 走三国杀解析与规则，generic 只陪聊。 */
  game: string;
  /** 窗口标题正则（不区分大小写），用来判断"你在打游戏"。 */
  windowPattern: string;
  /** 多久扫一次窗口，秒。 */
  pollSec: number;
  /**
   * 后台预读画面的间隔，秒。0=关掉。
   * 开着的意义：宠物问「该出什么」时画面已经是热的，不用等 1 秒多的截图+OCR。
   */
  refreshSec: number;
  /** 两次主动搭话之间至少隔多久，秒。 */
  commentEverySec: number;
  /** 游戏不在前台时不主动开口。 */
  quietOnBlur: boolean;
  /** 允许截图 + Windows OCR 读牌面。 */
  ocr: boolean;
  /** 分区裁切放大后再 OCR（卡牌类界面整屏 OCR 基本读不出）。 */
  regionOcr: boolean;
  /** 把这一帧作为图片附件交给模型（provider 不支持图片时会自动退化成文字）。 */
  sendImage: boolean;
  /** OCR 语言标签，如 zh-Hans。 */
  ocrLanguage: string;
  /** 语气：tilt=毒舌吐槽，coach=教练，quiet=只在被问时说。 */
  posture: string;
  /** 一局里最多主动搭话多少次。 */
  maxPerMatch: number;
  /** 库里没有的武将，自动联网（biligame wiki）抓一次并存进本地库。 */
  autoLearn: boolean;
  /**
   * 优先用哪个 wiki：auto=移动版→综合→OL 依次兜底；也可以固定某个源优先，其余仍按顺序兜底。
   * 值：auto | msgs（三国杀移动版）| sgs（三国杀）| sgsol（三国杀 OL）
   */
  wikiSource: string;
  /** 打开数据库编辑页面（127.0.0.1 上的小网页，改武将库和黑话库）。 */
  editor: boolean;
  /** 编辑器端口；被占用时会自动往后找。 */
  editorPort: number;
  /** 直播采集：把对局里遇到的武将、弹幕里的新黑话记下来等确认。 */
  harvest: boolean;
  /** 多久读一次弹幕事件，秒。 */
  harvestSec: number;
  /** 武将库采集：读屏认出的武将自动记进采集清单、库里没有的顺手联网补。可随时开关。 */
  collectGenerals: boolean;
  /** 黑话库采集：把直播弹幕里的生词攒成候选等你确认。可随时开关。 */
  collectSlang: boolean;
}

export const GAMEBUDDY_ID = 'gamebuddy';

export const GAMEBUDDY_DEFAULTS: GameBuddyConfig = {
  enabled: true,
  armed: true,
  game: 'sanguosha',
  windowPattern: '三国杀|Sanguosha|无名杀|sgs|sanguo|雷电模拟器|LDPlayer|dnplayer',
  pollSec: 8,
  refreshSec: 3,
  commentEverySec: 150,
  quietOnBlur: true,
  ocr: true,
  regionOcr: true,
  sendImage: true,
  ocrLanguage: 'zh-Hans',
  posture: 'tilt',
  maxPerMatch: 30,
  autoLearn: true,
  wikiSource: 'auto',
  editor: true,
  editorPort: 17790,
  harvest: true,
  harvestSec: 15,
  collectGenerals: true,
  collectSlang: true,
};

export function gamebuddyConfigGroup(language: Language = 'zh'): ConfigGroup {
  const zh = language !== 'en';
  const t = zh
    ? {
        title: '陪玩搭子',
        desc: '识别你在打哪款游戏、隔一阵子吐槽一句，并在你要建议时给出具体打法。',
        armed: '陪玩开关',
        armedDesc: '关掉后不主动搭话、不读屏，工具直接拒绝；面板上的开关会写回这里，重启后保持。',
        game: '游戏档位',
        gameDesc: 'sanguosha 启用三国杀牌面解析与决策规则；generic 只做陪伴与闲聊。',
        pat: '窗口标题关键字',
        patDesc: '正则，匹配游戏窗口标题。默认覆盖三国杀/无名杀等。',
        poll: '扫描间隔',
        pollDesc: '多久看一次游戏窗口在不在前台，单位秒。',
        refresh: '画面预读间隔',
        refreshDesc: '打游戏时后台多久重读一次画面，单位秒；0 关掉。开着时问打法几乎不用等读屏。',
        every: '搭话间隔',
        everyDesc: '两次主动吐槽之间至少隔多久，单位秒。',
        quiet: '不在前台就闭嘴',
        quietDesc: '切出游戏（看网页、聊天）时不主动开口。',
        ocr: '读屏（截图 + OCR）',
        ocrDesc: '允许搭子截图并用系统 OCR 读牌面文字；关掉则只能靠你口述局势。',
        regionOcr: '分区读屏',
        regionOcrDesc: '把手牌区、身份区裁出来放大两倍再 OCR；卡牌界面整屏读几乎全是噪声。',
        sendImage: '把截图交给模型',
        sendImageDesc: '读屏时把这一帧作为图片附件发给模型；模型不支持图片时会自动退回文字。',
        autoLearn: '库外武将自动联网',
        autoLearnDesc: '问到库里没有的武将时，自动去三国杀 wiki 抓一次，解析后存进本地库（只抓一次，以后本地命中）。',
        wikiSource: '优先数据源',
        wikiSourceDesc: 'auto 按「移动版 → 综合 → OL」依次尝试，前一个连不上就换下一个；也可以固定某个源优先，其余仍会自动兜底。',
        editor: '数据库编辑页面',
        editorDesc: '在 http://127.0.0.1:端口 起一个小网页，可以直接加武将、改技能、录黑话；只监听本机，不对外。',
        editorPort: '编辑页面端口',
        harvest: '直播采集',
        harvestDesc: '边直播边把对局里遇到的武将、弹幕里冒出的新黑话记下来，攒成待确认清单；确认后写进库，下次就认得。',
        harvestSec: '采集间隔',
        collectGenerals: '武将库采集',
        collectGeneralsDesc: '读屏认出的武将自动记进采集清单，库里没有的顺手联网补一条。想专心打、不想攒东西时关掉。',
        collectSlang: '黑话库采集',
        collectSlangDesc: '把直播弹幕里的生词攒成候选，等你确认才入库。没人说话或者不想记时关掉。',
        lang: 'OCR 语言',
        langDesc: 'Windows OCR 的语言标签，中文是 zh-Hans。',
        posture: '语气',
        postureDesc: 'tilt 毒舌吐槽、coach 认真教练、quiet 只在被问时开口。',
        cap: '每局上限',
        capDesc: '一局里最多主动搭话多少次，防止刷屏。',
        suffixSec: '秒',
        suffixTimes: '次',
      }
    : {
        title: 'Play-along buddy',
        desc: 'Notices the game you are running, roasts the board now and then, and answers "what should I play".',
        armed: 'Companion switch',
        armedDesc: 'When off it stays silent, does not read the screen, and tools refuse; the panel switch writes here and survives restarts.',
        game: 'Game profile',
        gameDesc: 'sanguosha enables board parsing and decision rules; generic is chat-only company.',
        pat: 'Window title pattern',
        patDesc: 'A regular expression matched against game window titles.',
        poll: 'Poll interval',
        pollDesc: 'How often the window is checked, in seconds.',
        refresh: 'Frame preload interval',
        refreshDesc: 'How often the frame is re-read in the background while playing, in seconds; 0 disables.',
        every: 'Comment interval',
        everyDesc: 'Minimum gap between two spontaneous comments, in seconds.',
        quiet: 'Stay quiet when unfocused',
        quietDesc: 'Do not speak up while the game is not in the foreground.',
        ocr: 'Screen reading (capture + OCR)',
        ocrDesc: 'Let the buddy capture the game window and read text with Windows OCR.',
        regionOcr: 'Region OCR',
        regionOcrDesc: 'Crop the hand and status strips and upscale before OCR; whole-frame OCR on a card game is mostly noise.',
        sendImage: 'Send the frame to the model',
        sendImageDesc: 'Attach the captured frame as an image; providers without image support fall back to text.',
        autoLearn: 'Auto-fetch unknown generals',
        autoLearnDesc: 'When a general is missing, fetch it once from a Sanguosha wiki, parse it, and store it locally.',
        wikiSource: 'Preferred source',
        wikiSourceDesc: 'auto tries mobile → main → OL in order; pick one to prefer it, the rest still act as fallbacks.',
        editor: 'Database editor page',
        editorDesc: 'Serves a small page on 127.0.0.1 for adding generals, fixing skills and recording slang; loopback only.',
        editorPort: 'Editor port',
        harvest: 'Live harvesting',
        harvestDesc: 'While live, records generals seen in matches and new slang in chat into a review list; approving writes it into the books.',
        harvestSec: 'Harvest interval',
        collectGenerals: 'General collection',
        collectGeneralsDesc: 'Records generals spotted on screen and fills missing ones from the wiki. Turn off when you just want to play.',
        collectSlang: 'Slang collection',
        collectSlangDesc: 'Collects new words from live chat into a review list; nothing is written until you approve it.',
        lang: 'OCR language',
        langDesc: 'A Windows OCR language tag, e.g. zh-Hans.',
        posture: 'Tone',
        postureDesc: 'tilt roasts, coach explains, quiet only speaks when asked.',
        cap: 'Comments per match',
        capDesc: 'Hard cap on spontaneous comments in one session.',
        suffixSec: 's',
        suffixTimes: '×',
      };
  return {
    id: `world:${GAMEBUDDY_ID}`,
    owner: `world:${GAMEBUDDY_ID}`,
    schema: {
      type: 'object',
      title: t.title,
      description: t.desc,
      properties: {
        [`worlds.${GAMEBUDDY_ID}.armed`]: {
          type: 'boolean',
          title: t.armed,
          'x-hot': true,
          description: t.armedDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.game`]: {          type: 'string',
          title: t.game,
          enum: ['sanguosha', 'generic'],
          'x-options': 'game',
          'x-hot': false,
          description: t.gameDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.windowPattern`]: {
          type: 'string',
          title: t.pat,
          'x-hot': true,
          description: t.patDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.pollSec`]: {
          type: 'integer',
          title: t.poll,
          minimum: 3,
          maximum: 120,
          'x-suffix': t.suffixSec,
          'x-hot': true,
          description: t.pollDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.refreshSec`]: {
          type: 'integer',
          title: t.refresh,
          minimum: 0,
          maximum: 30,
          'x-suffix': t.suffixSec,
          'x-hot': true,
          description: t.refreshDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.commentEverySec`]: {
          type: 'integer',
          title: t.every,
          minimum: 30,
          maximum: 1800,
          'x-suffix': t.suffixSec,
          'x-hot': true,
          description: t.everyDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.quietOnBlur`]: {
          type: 'boolean',
          title: t.quiet,
          'x-hot': true,
          description: t.quietDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.ocr`]: {
          type: 'boolean',
          title: t.ocr,
          'x-hot': false,
          description: t.ocrDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.regionOcr`]: {
          type: 'boolean',
          title: t.regionOcr,
          'x-hot': true,
          description: t.regionOcrDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.sendImage`]: {
          type: 'boolean',
          title: t.sendImage,
          'x-hot': true,
          description: t.sendImageDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.autoLearn`]: {
          type: 'boolean',
          title: t.autoLearn,
          'x-hot': true,
          description: t.autoLearnDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.wikiSource`]: {
          type: 'string',
          title: t.wikiSource,
          enum: ['auto', 'msgs', 'sgs', 'sgsol'],
          'x-hot': true,
          description: t.wikiSourceDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.editor`]: {
          type: 'boolean',
          title: t.editor,
          'x-hot': false,
          description: t.editorDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.editorPort`]: {
          type: 'integer',
          title: t.editorPort,
          minimum: 1024,
          maximum: 65535,
          'x-hot': false,
          description: t.editorDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.harvest`]: {
          type: 'boolean',
          title: t.harvest,
          'x-hot': true,
          description: t.harvestDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.harvestSec`]: {
          type: 'integer',
          title: t.harvestSec,
          minimum: 5,
          maximum: 600,
          'x-suffix': t.suffixSec,
          'x-hot': true,
          description: t.harvestDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.collectGenerals`]: {
          type: 'boolean',
          title: t.collectGenerals,
          'x-hot': true,
          description: t.collectGeneralsDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.collectSlang`]: {
          type: 'boolean',
          title: t.collectSlang,
          'x-hot': true,
          description: t.collectSlangDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.ocrLanguage`]: {
          type: 'string',
          title: t.lang,
          'x-hot': false,
          description: t.langDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.posture`]: {
          type: 'string',
          title: t.posture,
          enum: ['tilt', 'coach', 'quiet'],
          'x-hot': true,
          description: t.postureDesc,
        },
        [`worlds.${GAMEBUDDY_ID}.maxPerMatch`]: {
          type: 'integer',
          title: t.cap,
          minimum: 1,
          maximum: 200,
          'x-suffix': t.suffixTimes,
          'x-hot': false,
          description: t.capDesc,
        },
      },
    },
  };
}
