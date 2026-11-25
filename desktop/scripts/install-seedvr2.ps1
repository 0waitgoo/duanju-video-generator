$ErrorActionPreference = 'Stop'
$root = Join-Path $env:LOCALAPPDATA 'DuanjuStudio/SeedVR2'
$engine = Join-Path $root 'engine'
$venv = Join-Path $root 'venv'
$models = Join-Path $root 'models'
$python = Join-Path $venv 'Scripts/python.exe'
$engineCommit = '4490bd1f482e026674543386bb2a4d176da245b9'

function Invoke-Native($program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed with exit code $LASTEXITCODE" }
}

function Get-Model($name, $repo, $expectedHash) {
    $target = Join-Path $models $name
    if ((Test-Path -LiteralPath $target) -and (Get-FileHash -LiteralPath $target).Hash -eq $expectedHash) { return }
    $partial = Join-Path $models "$name.part"
    $url = "https://huggingface.co/$repo/resolve/main/$name"
    Invoke-Native curl.exe @('-fL', '--retry', '3', '-C', '-', '-o', $partial, $url)
    if ((Get-FileHash -LiteralPath $partial).Hash -ne $expectedHash) { throw "SHA-256 verification failed for $name" }
    Move-Item -LiteralPath $partial -Destination $target -Force
}

New-Item -ItemType Directory -Path $models -Force | Out-Null
if (!(Test-Path -LiteralPath (Join-Path $engine '.git'))) {
    Invoke-Native git @('clone', '--no-checkout', 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git', $engine)
}
Invoke-Native git @('-C', $engine, 'checkout', '--detach', $engineCommit)
if (!(Test-Path -LiteralPath $python)) {
    Invoke-Native py @('-3.12', '-m', 'venv', $venv)
}
Invoke-Native $python @('-m', 'pip', 'install', 'torch==2.11.0+cu130', 'torchvision==0.26.0+cu130',
    '--index-url', 'https://download.pytorch.org/whl/cu130')
Invoke-Native $python @('-m', 'pip', 'install', '-r', (Join-Path $engine 'requirements.txt'))
Get-Model 'seedvr2_ema_3b-Q4_K_M.gguf' 'AInVFX/SeedVR2_comfyUI' 'e665e3909de1a8c88a69c609bca9d43ff5a134647face2ce4497640cc3597f0e'
Get-Model 'ema_vae_fp16.safetensors' 'numz/SeedVR2_comfyUI' '20678548f420d98d26f11442d3528f8b8c94e57ee046ef93dbb7633da8612ca1'
Invoke-Native $python @('-c', 'import torch; assert torch.cuda.is_available(), "CUDA is unavailable"; print(torch.cuda.get_device_name(0))')
Invoke-Native $python @('-X', 'utf8', (Join-Path $engine 'inference_cli.py'), '--help')
