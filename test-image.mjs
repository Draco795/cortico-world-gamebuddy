/**
 * 图像管线自检：造一张带文字的假截图，验证「裁切 + 高质量 JPEG + 锐度」三件事。
 * 不依赖游戏窗口，随时可跑：node test-image.mjs
 */
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DATA_DIR } from './dev.mjs';
import { cropImage, sharpnessOf } from './src/observe.ts';

const dir = join(DATA_DIR, 'tmp-image');
mkdirSync(dir, { recursive: true });
const png = join(dir, 'fake.png');
const jpg = join(dir, 'fake-hand.jpg');

const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
$bmp = New-Object System.Drawing.Bitmap 900, 600
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(20, 22, 28))
$font = New-Object System.Drawing.Font('Microsoft YaHei', 26, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.DrawString('闪 骅骝 无懈可击 杀', $font, $brush, 40, 470)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 170, 60)), 3
for ($i = 0; $i -lt 4; $i++) { $g.DrawRectangle($pen, (30 + $i * 210), 400, 180, 180) }
$g.Dispose()
$bmp.Save('${png.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
'ok'
`;
const draw = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
if (draw.status !== 0) {
  console.log('画图失败', draw.stderr.slice(-300));
  process.exit(1);
}
console.log('假截图：', statSync(png).size, 'bytes');

const sharp0 = await sharpnessOf(png);
console.log('整图锐度：', sharp0.score.toFixed(3));

const crop = await cropImage(png, jpg, { x: 0, y: 0.6, w: 0.7, h: 0.4 }, 2, 92);
console.log('裁切：', JSON.stringify(crop), '文件', crop.ok ? statSync(jpg).size : 0, 'bytes');

const sharp1 = await sharpnessOf(jpg);
console.log('特写锐度：', sharp1.score.toFixed(3));

const ok = sharp0.ok && crop.ok && sharp1.score > 0.02;
console.log(ok ? 'PASS 管线正常' : 'FAIL 检查上面的数字');
process.exit(ok ? 0 : 1);
