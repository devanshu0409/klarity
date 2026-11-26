# Rasterizes the Klarity mark into build/icon.png and a multi-size build/icon.ico.
#
# The mark is the logo: three ascending off-white bars on brand red. Corner
# rounding scales with size and is dropped below 32px, where a radius just eats
# pixels the bars need.
#
# Run: powershell -ExecutionPolicy Bypass -File scripts/make-icons.ps1

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$build = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $build | Out-Null

$red = [System.Drawing.Color]::FromArgb(255, 234, 46, 18)
$bar = [System.Drawing.Color]::FromArgb(255, 241, 241, 241)

function New-Mark([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $redBrush = New-Object System.Drawing.SolidBrush $red
  $barBrush = New-Object System.Drawing.SolidBrush $bar

  # Rounded-square ground.
  $r = if ($size -lt 32) { 0 } else { [int]($size * 0.21) }
  if ($r -le 0) {
    $g.FillRectangle($redBrush, 0, 0, $size, $size)
  } else {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc(($size - $d), 0, $d, $d, 270, 90)
    $path.AddArc(($size - $d), ($size - $d), $d, $d, 0, 90)
    $path.AddArc(0, ($size - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($redBrush, $path)
    $path.Dispose()
  }

  # Three ascending bars, proportional to the logo.
  $s = $size / 24.0
  $h = [Math]::Max(1.0, 3.0 * $s)
  foreach ($b in @(@(5.0, 7.0), @(10.5, 11.0), @(16.0, 14.8))) {
    $g.FillRectangle($barBrush, (4.6 * $s), ($b[0] * $s), ($b[1] * $s), $h)
  }

  $redBrush.Dispose(); $barBrush.Dispose(); $g.Dispose()
  return $bmp
}

function Get-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return , $bytes
}

# --- icon.png (macOS / Linux) ------------------------------------------------
$big = New-Mark 512
$big.Save((Join-Path $build 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$big.Dispose()

# --- icon.ico (Windows, PNG-compressed frames) -------------------------------
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($sz in $sizes) {
  $bmp = New-Mark $sz
  $frames += , @{ Size = $sz; Bytes = (Get-PngBytes $bmp) }
  $bmp.Dispose()
}

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([UInt16]0)              # reserved
$w.Write([UInt16]1)              # type: icon
$w.Write([UInt16]$frames.Count)

$offset = 6 + (16 * $frames.Count)
foreach ($f in $frames) {
  $dim = if ($f.Size -ge 256) { 0 } else { $f.Size }   # 0 means 256 in the ICO header
  $w.Write([Byte]$dim); $w.Write([Byte]$dim)
  $w.Write([Byte]0); $w.Write([Byte]0)                 # palette, reserved
  $w.Write([UInt16]1); $w.Write([UInt16]32)            # planes, bpp
  $w.Write([UInt32]$f.Bytes.Length)
  $w.Write([UInt32]$offset)
  $offset += $f.Bytes.Length
}
foreach ($f in $frames) { $w.Write($f.Bytes) }

$w.Flush()
[System.IO.File]::WriteAllBytes((Join-Path $build 'icon.ico'), $out.ToArray())
$w.Dispose(); $out.Dispose()

Write-Output "wrote build/icon.png (512) and build/icon.ico ($($sizes -join ','))"
