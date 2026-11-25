/**
 * 读屏体检：游戏开着的时候跑一次，就知道"看不清牌"卡在哪一环。
 *
 *   node diagnose.mjs              # 用默认窗口关键字
 *   node diagnose.mjs 三国杀        # 自定义关键字
 *
 * 输出：窗口/尺寸/是否被挡 → 截图耗时与体积 → 整图锐度 → 分区 OCR 行数 →
 *      手牌特写体积与锐度 → 最后给一句结论（该调哪个旋钮）。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './dev.mjs';
import { captureWindow, cropImage, detect, ocrRegions, sharpnessOf } from './src/observe.ts';

const pattern = process.argv[2] || '三国杀|Sanguosha|sanguo|雷电模拟器|LDPlayer|dnplayer';
const REGIONS = [
  { id: 'status', x: 0.0, y: 0.05, w: 0.32, h: 0.16, scale: 2.2 },
  { id: 'table', x: 0.02, y: 0.05, w: 0.96, h: 0.62, scale: 1.6 },
  { id: 'hand', x: 0.0, y: 0.68, w: 0.72, h: 0.3, scale: 2.4 },
  { id: 'self', x: 0.7, y: 0.66, w: 0.3, h: 0.34, scale: 3.0 },
];
const HAND_CROP = { x: 0.0, y: 0.6, w: 0.7, h: 0.4 };

const dir = join(DATA_DIR, 'diag');
mkdirSync(dir, { recursive: true });

const det = await detect(pattern);
console.log('窗口：', det.windows.length === 0 ? '（没找到）' : det.windows.map((w) => `${w.title} ${w.w}×${w.h}`).join(' / '));
const target = [...det.windows].sort((a, b) => (b.w ?? 0) * (b.h ?? 0) - (a.w ?? 0) * (a.h ?? 0))[0];
if (!target) {
  console.log('没有游戏窗口：先把模拟器开起来、进到对局里再跑这个脚本。');
  process.exit(0);
}
console.log(`目标窗口：${target.title} ${target.w}×${target.h}（pid ${target.pid}）`);

const frame = join(dir, 'frame.jpg');
const t0 = Date.now();
const shot = await captureWindow(target.hwnd, frame, { focus: target.pid !== det.foregroundPid });
console.log(`截图：ok=${shot.ok} 尺寸=${shot.size ?? '?'} 遮挡=${shot.occluded ? '是（这会让牌面糊/夹叠影）' : '否'} 耗时=${Date.now() - t0}ms`);
if (!shot.ok) {
  console.log('截图失败：', shot.error);
  process.exit(0);
}

const sharp = await sharpnessOf(frame);
console.log(`整图锐度：${sharp.score.toFixed(3)}（经验值：>0.05 清楚，0.02–0.05 一般，<0.02 糊）`);

const read = await ocrRegions(frame, REGIONS, join(dir, 'regions'), 'zh-Hans');
console.log(`分区 OCR：ok=${read.ok} ${read.error ?? ''}`);
for (const r of read.regions) {
  const sample = r.lines.slice(0, 2).join(' / ').slice(0, 60);
  console.log(`  ${r.id.padEnd(7)} 行数=${String(r.lines.length).padStart(2)}  ${sample}`);
}

const hand = join(dir, 'hand-focus.jpg');
const crop = await cropImage(frame, hand, HAND_CROP, 2, 92);
if (crop.ok) {
  const hs = await sharpnessOf(hand);
  console.log(`手牌特写：${crop.size} 锐度=${hs.score.toFixed(3)}（>0.05 牌名看得清）`);
} else {
  console.log('手牌特写失败：', crop.error);
}

const handLines = read.regions.find((r) => r.id === 'hand')?.lines ?? [];
const verdict =
  !read.ok
    ? 'OCR 整个挂了：检查系统中文 OCR 语言包（设置→语言→中文→可选功能）。'
    : handLines.length === 0
      ? '手牌区 OCR 一个字都没认出来——这是手写体卡面的老毛病，看手牌特写那张图（这也是现在插件会额外挂图的原因）。'
      : sharp.score < 0.03
        ? '整图偏糊：可能被别的窗口压着、或模拟器缩放/动态模糊。让游戏窗口保持前台再看。'
        : '这一帧的状态不错，可以直接照着读。';
console.log('结论：', verdict);
console.log('产物都在：', dir);
