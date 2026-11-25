/**
 * Windows 观测层：找游戏窗口、判断前台、截窗口、跑系统 OCR。
 *
 * 全部走 Windows PowerShell 5.1 子进程：Coopanion 主进程里没有现成的截图/OCR 能力，
 * 而 System.Drawing + Windows.Media.Ocr 在 5.1 上都能直接用，不需要额外依赖。
 * 所有外部输入（窗口标题正则、输出路径）都经环境变量传入，不拼进脚本正文。
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WindowInfo {
  pid: number;
  process: string;
  title: string;
  hwnd: number;
  /** 窗口类名；模拟器/游戏常用固定类名，比标题更稳。 */
  cls?: string;
  /** 窗口宽高（物理像素），用来在多窗口里挑真正的那块画面。 */
  w?: number;
  h?: number;
}

export interface DetectResult {
  ok: boolean;
  foregroundPid: number;
  windows: WindowInfo[];
  error?: string;
}

const PS = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runPs(script: string, env: Record<string, string>, timeoutMs = 20_000): Promise<RunResult> {
  // PowerShell 5.1 的 stdout 默认走控制台 OEM 代码页（简中机器是 GBK），
  // Node 按 UTF-8 解码会把窗口标题、OCR 牌名全变成乱码。每个脚本先钉死 UTF-8。
  const preamble =
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;'
    + '$OutputEncoding=[System.Text.Encoding]::UTF8;'
    + '$ErrorActionPreference="Stop";';
  const full = preamble + script;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full], {
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code: null, stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(error) });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const DETECT_SCRIPT = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class GBWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[GBWin]::SetProcessDPIAware() | Out-Null
$fg = [GBWin]::GetForegroundWindow()
$fgPid = [uint32]0
[GBWin]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
$pat = $env:GB_PAT
$procs = @{}
foreach ($p in Get-Process) { $procs[[int]$p.Id] = [string]$p.ProcessName }
$list = New-Object System.Collections.ArrayList
$cb = [GBWin+EnumProc]{
  param($h, $l)
  if (-not [GBWin]::IsWindowVisible($h)) { return $true }
  $rb = New-Object System.Text.StringBuilder 512
  [void][GBWin]::GetWindowTextW($h, $rb, 512)
  $title = $rb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $cb2 = New-Object System.Text.StringBuilder 256
  [void][GBWin]::GetClassNameW($h, $cb2, 256)
  $cls = $cb2.ToString()
  $pid2 = [uint32]0
  [void][GBWin]::GetWindowThreadProcessId($h, [ref]$pid2)
  $procName = if ($procs.ContainsKey([int]$pid2)) { $procs[[int]$pid2] } else { '' }
  $r = New-Object GBWin+RECT
  [void][GBWin]::GetWindowRect($h, [ref]$r)
  $w = $r.Right - $r.Left
  $hg = $r.Bottom - $r.Top
  if ($w -lt 120 -or $hg -lt 80) { return $true }
  if (($title -match $pat) -or ($procName -match $pat) -or ($cls -match $pat)) {
    [void]$list.Add([pscustomobject]@{
      pid = [int]$pid2
      process = $procName
      title = $title
      hwnd = [long]$h
      cls = $cls
      w = $w
      h = $hg
    })
  }
  return $true
}
[void][GBWin]::EnumWindows($cb, [IntPtr]::Zero)
[pscustomobject]@{ foregroundPid = [long]$fgPid; windows = @($list) } | ConvertTo-Json -Depth 4 -Compress
`;

const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class GBCap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[GBCap]::SetProcessDPIAware() | Out-Null
$h = [IntPtr][long]$env:GB_HWND
$topmost = $false
if ($env:GB_FOCUS -eq '1') {
  if ([GBCap]::IsIconic($h)) { [void][GBCap]::ShowWindow($h, 9) }
  [void][GBCap]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 400
  # 非前台进程调 SetForegroundWindow 会被系统忽略，此时临时置顶，截完再恢复
  if ([GBCap]::GetForegroundWindow() -ne $h) {
    [void][GBCap]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0003)
    Start-Sleep -Milliseconds 600
    $topmost = $true
  }
}
$r = New-Object GBCap+RECT
if (-not [GBCap]::GetWindowRect($h, [ref]$r)) { throw 'GetWindowRect failed' }
$w = $r.Right - $r.Left
$hgt = $r.Bottom - $r.Top
if ($w -le 0 -or $hgt -le 0) { throw "bad rect: $w x $hgt" }
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$ext = [System.IO.Path]::GetExtension($env:GB_OUT).ToLowerInvariant()
if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  # 牌面是手绘小字，85 糊得看不清；默认 92，体积多三成，字口清楚得多
  $q = if ($env:GB_Q) { [int]$env:GB_Q } else { 92 }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
  $bmp.Save($env:GB_OUT, $codec, $ep)
} else {
  $bmp.Save($env:GB_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
}
$g.Dispose()
$bmp.Dispose()
# 抓完再看一次前台：还不是它，说明画面很可能被别的窗口盖着
$state = if ($env:GB_FOCUS -eq '1' -and [GBCap]::GetForegroundWindow() -ne $h) { 'occluded' } else { 'ok' }
if ($topmost) { [void][GBCap]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003) }
Write-Output ("{0}x{1} {2}" -f $w, $hgt, $state)
`;

const OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:GB_PNG)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:GB_LANG)) } catch { }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR engine for this language' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
@($result.Lines | ForEach-Object { $_.Text }) | ConvertTo-Json -Compress
`;

export async function detect(pattern: string): Promise<DetectResult> {
  const safePattern = pattern.trim() === '' ? 'a^' : pattern;
  const out = await runPs(DETECT_SCRIPT, { GB_PAT: safePattern }, 15_000);
  if (out.code !== 0) {
    return { ok: false, foregroundPid: 0, windows: [], error: (out.stderr || 'powershell failed').slice(0, 400) };
  }
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
  if (!line) return { ok: false, foregroundPid: 0, windows: [], error: 'no json from detect' };
  try {
    const parsed = JSON.parse(line) as { foregroundPid?: number; windows?: WindowInfo[] | WindowInfo };
    const windows = parsed.windows === undefined ? [] : Array.isArray(parsed.windows) ? parsed.windows : [parsed.windows];
    return { ok: true, foregroundPid: Number(parsed.foregroundPid ?? 0), windows };
  } catch (error) {
    return { ok: false, foregroundPid: 0, windows: [], error: `bad json: ${String(error)}` };
  }
}

export async function captureWindow(
  hwnd: number,
  outPath: string,
  opts: { focus?: boolean } = {},
): Promise<{ ok: boolean; size?: string; occluded?: boolean; error?: string }> {
  try {
    mkdirSync(dirname(outPath), { recursive: true });
  } catch {
    /* 目录建不出来时让 PowerShell 报真正的错 */
  }
  const out = await runPs(
    CAPTURE_SCRIPT,
    { GB_HWND: String(hwnd), GB_OUT: outPath, GB_FOCUS: opts.focus ? '1' : '0', GB_Q: '92' },
    25_000,
  );
  if (out.code !== 0) return { ok: false, error: (out.stderr || 'capture failed').slice(-400) };
  const parts = out.stdout.trim().split(/\s+/);
  return { ok: true, size: parts[0], occluded: parts[1] === 'occluded' };
}

export async function ocrImage(pngPath: string, language: string): Promise<{ ok: boolean; lines: string[]; error?: string }> {
  // WinRT 的 StorageFile.GetFileFromPathAsync 只认反斜杠的 Win32 路径
  const winPath = pngPath.replace(/\//g, '\\');
  const out = await runPs(OCR_SCRIPT, { GB_PNG: winPath, GB_LANG: language || 'zh-Hans' }, 40_000);
  if (out.code !== 0) return { ok: false, lines: [], error: (out.stderr || 'ocr failed').slice(-400) };
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('[')).pop() ?? '[]';
  try {
    const lines = JSON.parse(line) as string[];
    return { ok: true, lines: lines.map((l) => l.trim()).filter((l) => l !== '') };
  } catch (error) {
    return { ok: false, lines: [], error: `bad ocr json: ${String(error)}` };
  }
}

const OCR_BOXES_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:GB_PNG)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:GB_LANG)) } catch { }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR engine for this language' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$rows = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  $minX = 1e9; $minY = 1e9; $maxX = -1e9; $maxY = -1e9
  foreach ($w in $line.Words) {
    $r = $w.BoundingRect
    if ($r.X -lt $minX) { $minX = $r.X }
    if ($r.Y -lt $minY) { $minY = $r.Y }
    if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
  }
  if ($maxX -lt 0) { continue }
  [void]$rows.Add([pscustomobject]@{
    text = [string]$line.Text
    x = [int]$minX
    y = [int]$minY
    w = [int]($maxX - $minX)
    h = [int]($maxY - $minY)
  })
}
$stream.Dispose()
$bitmap.Dispose()
@($rows) | ConvertTo-Json -Depth 4 -Compress
`;

/** 一行识别结果 + 它的外接矩形（像素，左上角原点）。点按钮就点矩形中心。 */
export interface OcrBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 整图 OCR 但带坐标，给自动打游戏找按钮用。 */
export async function ocrBoxes(pngPath: string, language: string): Promise<{ ok: boolean; boxes: OcrBox[]; error?: string }> {
  const winPath = pngPath.replace(/\//g, '\\');
  const out = await runPs(OCR_BOXES_SCRIPT, { GB_PNG: winPath, GB_LANG: language || 'zh-Hans' }, 40_000);
  if (out.code !== 0) return { ok: false, boxes: [], error: (out.stderr || 'ocr boxes failed').slice(-400) };
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('[')).pop() ?? '[]';
  try {
    const raw = JSON.parse(line) as Array<{ text?: string; x?: number; y?: number; w?: number; h?: number }>;
    const boxes = raw
      .map((box) => ({
        text: String(box.text ?? '').trim(),
        x: Number(box.x ?? 0),
        y: Number(box.y ?? 0),
        w: Number(box.w ?? 0),
        h: Number(box.h ?? 0),
      }))
      .filter((box) => box.text !== '' && box.w > 4 && box.h > 4);
    return { ok: true, boxes };
  } catch (error) {
    return { ok: false, boxes: [], error: `bad ocr box json: ${String(error)}` };
  }
}

const OCR_BOXES_CROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapBounds, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$scale = [double]$env:GB_SCALE
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:GB_PNG)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$w = [int]$decoder.PixelWidth
$h = [int]$decoder.PixelHeight
$bx = [int]([double]$env:GB_X * $w)
$by = [int]([double]$env:GB_Y * $h)
$bw = [Math]::Min([int]([double]$env:GB_W * $w), $w - $bx)
$bh = [Math]::Min([int]([double]$env:GB_H * $h), $h - $by)
if ($bw -lt 8 -or $bh -lt 8) { throw 'crop too small' }
Add-Type -AssemblyName System.Drawing | Out-Null
$src = [System.Drawing.Image]::FromFile($env:GB_PNG)
$rect = New-Object System.Drawing.Rectangle($bx, $by, $bw, $bh)
$sw = [Math]::Max(1, [int]($bw * $scale))
$sh = [Math]::Max(1, [int]($bh * $scale))
$cropBmp = New-Object System.Drawing.Bitmap($sw, $sh)
$graphics = [System.Drawing.Graphics]::FromImage($cropBmp)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$cropPath = Join-Path $env:TEMP ('gb-crop-' + [guid]::NewGuid().ToString('N') + '.png')
$cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$cropBmp.Dispose()
$src.Dispose()
$stream.Dispose()
$cropFile = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cropPath)) ([Windows.Storage.StorageFile])
$cropStream = Await ($cropFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$cropDecoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($cropStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($cropDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:GB_LANG)) } catch { }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR engine for this language' }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$rows = New-Object System.Collections.ArrayList
foreach ($line in $result.Lines) {
  $minX = 1e9; $minY = 1e9; $maxX = -1e9; $maxY = -1e9
  foreach ($word in $line.Words) {
    $r = $word.BoundingRect
    if ($r.X -lt $minX) { $minX = $r.X }
    if ($r.Y -lt $minY) { $minY = $r.Y }
    if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
    if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
  }
  if ($maxX -lt 0) { continue }
  [void]$rows.Add([pscustomobject]@{
    text = [string]$line.Text
    x = [int]($bx + ($minX / $scale))
    y = [int]($by + ($minY / $scale))
    w = [int](($maxX - $minX) / $scale)
    h = [int](($maxY - $minY) / $scale)
  })
}
$stream.Dispose()
$cropStream.Dispose()
$bitmap.Dispose()
Remove-Item $cropPath -Force -ErrorAction SilentlyContinue
@($rows) | ConvertTo-Json -Depth 4 -Compress
`;

const CROP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
$src = [System.Drawing.Image]::FromFile($env:GB_PNG)
$bx = [int]([double]$env:GB_X * $src.Width)
$by = [int]([double]$env:GB_Y * $src.Height)
$bw = [Math]::Min([int]([double]$env:GB_W * $src.Width), $src.Width - $bx)
$bh = [Math]::Min([int]([double]$env:GB_H * $src.Height), $src.Height - $by)
$scale = [double]$env:GB_SCALE
$rect = New-Object System.Drawing.Rectangle($bx, $by, $bw, $bh)
$sw = [Math]::Max(1, [int]($bw * $scale))
$sh = [Math]::Max(1, [int]($bh * $scale))
$crop = New-Object System.Drawing.Bitmap($sw, $sh)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, (New-Object System.Drawing.Rectangle(0, 0, $sw, $sh)), $rect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$ext = [System.IO.Path]::GetExtension($env:GB_OUT).ToLower()
if ($ext -eq '.jpg' -or $ext -eq '.jpeg') {
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $q = if ($env:GB_Q) { [int]$env:GB_Q } else { 92 }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality, [long]$q)
  $crop.Save($env:GB_OUT, $codec, $ep)
} else {
  $crop.Save($env:GB_OUT, [System.Drawing.Imaging.ImageFormat]::Png)
}
$crop.Dispose()

$src.Dispose()
'saved ' + $sw + 'x' + $sh
`;

/** 把画面的一块裁出来存成文件（比例坐标），给多模态看。 */
export async function cropImage(
  pngPath: string,
  outPath: string,
  crop: { x: number; y: number; w: number; h: number },
  scale = 2,
  quality = 92,
): Promise<{ ok: boolean; size?: string; error?: string }> {
  const out = await runPs(
    CROP_SCRIPT,
    {
      GB_PNG: pngPath.replace(/\//g, '\\'),
      GB_OUT: outPath.replace(/\//g, '\\'),
      GB_X: String(crop.x),
      GB_Y: String(crop.y),
      GB_W: String(crop.w),
      GB_H: String(crop.h),
      GB_SCALE: String(scale),
      GB_Q: String(quality),
    },
    30_000,
  );
  if (out.code !== 0) return { ok: false, error: (out.stderr || 'crop failed').slice(-300) };
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('saved')).pop();
  return { ok: true, size: line?.replace('saved ', '') };
}

const SHARP_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing | Out-Null
$bmp = [System.Drawing.Bitmap]::FromFile($env:GB_PNG)
$w = $bmp.Width; $h = $bmp.Height
# 只采样一个网格，够判断"糊不糊"，不用逐像素
$sx = [Math]::Max(1, [int]($w / 96))
$sy = [Math]::Max(1, [int]($h / 54))
$sum = 0.0; $n = 0
for ($y = $sy; $y -lt $h - $sy; $y += $sy) {
  for ($x = $sx; $x -lt $w - $sx; $x += $sx) {
    $p = $bmp.GetPixel($x, $y).GetBrightness()
    $q = $bmp.GetPixel($x + $sx, $y).GetBrightness()
    $r = $bmp.GetPixel($x, $y + $sy).GetBrightness()
    $sum += [Math]::Abs($p - $q) + [Math]::Abs($p - $r)
    $n += 2
  }
}
$bmp.Dispose()
$score = if ($n -gt 0) { $sum / $n } else { 0 }
'{0:F4} {1}' -f $score, $n
`;

/**
 * 画面"锐度"：相邻采样点的亮度差均值。
 * 越小越糊（被压缩、被缩放、被别的窗口盖住），用来判断这张图值不值得给模型看。
 */
export async function sharpnessOf(pngPath: string): Promise<{ ok: boolean; score: number; error?: string }> {
  const out = await runPs(SHARP_SCRIPT, { GB_PNG: pngPath.replace(/\//g, '\\') }, 30_000);
  if (out.code !== 0) return { ok: false, score: 0, error: (out.stderr || 'sharp failed').slice(-300) };
  const score = Number.parseFloat(out.stdout.trim().split(/\s+/)[0] ?? '0');
  return { ok: true, score: Number.isFinite(score) ? score : 0 };
}
/** 只 OCR 画面的一块（比例），放大若干倍再认，坐标换回整屏像素。手牌字很小，全靠这个。 */export async function ocrBoxesCropped(
  pngPath: string,
  language: string,
  crop: { x: number; y: number; w: number; h: number },
  scale = 1.5,
): Promise<{ ok: boolean; boxes: OcrBox[]; error?: string }> {
  const winPath = pngPath.replace(/\//g, '\\');
  const out = await runPs(
    OCR_BOXES_CROP_SCRIPT,
    {
      GB_PNG: winPath,
      GB_LANG: language || 'zh-Hans',
      GB_X: String(crop.x),
      GB_Y: String(crop.y),
      GB_W: String(crop.w),
      GB_H: String(crop.h),
      GB_SCALE: String(scale),
    },
    40_000,
  );
  if (out.code !== 0) return { ok: false, boxes: [], error: (out.stderr || 'ocr crop failed').slice(-400) };
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('[')).pop() ?? '[]';
  try {
    const raw = JSON.parse(line) as Array<{ text?: string; x?: number; y?: number; w?: number; h?: number }>;
    const boxes = raw
      .map((box) => ({
        text: String(box.text ?? '').trim(),
        x: Number(box.x ?? 0),
        y: Number(box.y ?? 0),
        w: Number(box.w ?? 0),
        h: Number(box.h ?? 0),
      }))
      .filter((box) => box.text !== '' && box.w > 4 && box.h > 4);
    return { ok: true, boxes };
  } catch (error) {
    return { ok: false, boxes: [], error: `bad ocr crop json: ${String(error)}` };
  }
}


/** 相对窗口的裁切区域；x/y/w/h 都是 0-1 的比例，scale 是放大倍数。 */export interface Region {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
}

export interface RegionText {
  id: string;
  lines: string[];
  path?: string;
}

const OCR_REGIONS_SCRIPT = `
Add-Type -AssemblyName System.Drawing | Out-Null
Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$engine = $null
try { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($env:GB_LANG)) } catch { }
if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
if (-not $engine) { throw 'no OCR engine for this language' }
$src = [System.Drawing.Image]::FromFile($env:GB_PNG)
$regions = $env:GB_REGIONS | ConvertFrom-Json
$results = New-Object System.Collections.ArrayList
foreach ($r in $regions) {
  $x = [int]($src.Width * [double]$r.x)
  $y = [int]($src.Height * [double]$r.y)
  $w = [int]($src.Width * [double]$r.w)
  $h = [int]($src.Height * [double]$r.h)
  if ($w -lt 16 -or $h -lt 16) { continue }
  $scale = if ($r.scale) { [double]$r.scale } else { 2.0 }
  $bw = [int]($w * $scale)
  $bh = [int]($h * $scale)
  $big = New-Object System.Drawing.Bitmap $bw, $bh
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $dest = New-Object System.Drawing.Rectangle 0, 0, $bw, $bh
  $source = New-Object System.Drawing.Rectangle $x, $y, $w, $h
  $g.DrawImage($src, $dest, $source, [System.Drawing.GraphicsUnit]::Pixel)
  $g.Dispose()
  $p = Join-Path $env:GB_OUTDIR ($r.id + '.png')
  $big.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($p)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  [void]$results.Add([pscustomobject]@{
    id = [string]$r.id
    path = $p
    lines = @($ocr.Lines | ForEach-Object { $_.Text })
  })
  $stream.Dispose()
  $bitmap.Dispose()
}
$src.Dispose()
@($results) | ConvertTo-Json -Depth 5 -Compress
`;

/**
 * 按区域裁切 → 放大 → 逐块 OCR。
 * 整窗 OCR 在卡牌游戏上几乎读不出字：字被缩到 10px，还被卡面花纹压着；
 * 裁出手牌条放大两倍，同样的引擎能多认出一半。
 */
export async function ocrRegions(
  pngPath: string,
  regions: readonly Region[],
  outDir: string,
  language: string,
): Promise<{ ok: boolean; regions: RegionText[]; error?: string }> {
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const out = await runPs(
    OCR_REGIONS_SCRIPT,
    {
      GB_PNG: pngPath.replace(/\//g, '\\'),
      GB_REGIONS: JSON.stringify(regions),
      GB_OUTDIR: outDir,
      GB_LANG: language || 'zh-Hans',
    },
    60_000,
  );
  if (out.code !== 0) return { ok: false, regions: [], error: (out.stderr || 'region ocr failed').slice(-500) };
  const line = out.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('[')).pop() ?? '[]';
  try {
    const parsed = JSON.parse(line) as Array<{ id: string; path?: string; lines?: string[] }>;
    return {
      ok: true,
      regions: parsed.map((r) => ({
        id: r.id,
        path: r.path,
        lines: (r.lines ?? []).map((l) => l.trim()).filter((l) => l !== ''),
      })),
    };
  } catch (error) {
    return { ok: false, regions: [], error: `bad region json: ${String(error)}` };
  }
}
