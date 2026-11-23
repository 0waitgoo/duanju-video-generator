param([string]$Archive)
$ErrorActionPreference = 'Stop'
$DuanjuRuntime = Join-Path $PSScriptRoot 'runtime'
$DuanjuVersion = '8.1.2'
$DuanjuPackage = "ffmpeg-$DuanjuVersion-full_build"
$DuanjuDigest = 'B8CDEFAB5F50590A076C27C2B56B0294A0E6154FADED28BA1BA05EBC4F801F57'
if (-not $Archive) {
  $Archive = Join-Path ([IO.Path]::GetTempPath()) "$DuanjuPackage.zip"
  if (-not (Test-Path -LiteralPath $Archive)) {
    curl.exe -fL --retry 2 "https://github.com/GyanD/codexffmpeg/releases/download/$DuanjuVersion/$DuanjuPackage.zip" --output $Archive
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg download failed.' }
  }
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Archive).Hash -ne $DuanjuDigest) {
  throw 'FFmpeg archive checksum mismatch.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$DuanjuZip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try {
  New-Item -ItemType Directory -Path $DuanjuRuntime -Force | Out-Null
  [IO.Compression.ZipFileExtensions]::ExtractToFile($DuanjuZip.GetEntry("$DuanjuPackage/bin/ffmpeg.exe"), (Join-Path $DuanjuRuntime 'ffmpeg.exe'), $true)
  [IO.Compression.ZipFileExtensions]::ExtractToFile($DuanjuZip.GetEntry("$DuanjuPackage/LICENSE"), (Join-Path $DuanjuRuntime 'FFmpeg-LICENSE.txt'), $true)
} finally {
  $DuanjuZip.Dispose()
}

