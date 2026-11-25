'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { encode, probe } = require('./render');

const dit = 'seedvr2_ema_3b-Q4_K_M.gguf';
const vae = 'ema_vae_fp16.safetensors';

function runSeed(python, args, work, ffmpeg, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-u', ...args], {
      cwd: work, windowsHide: true,
      env: { ...process.env, PATH: path.dirname(ffmpeg) + path.delimiter + process.env.PATH,
        PYTHONUTF8: '1', HF_HUB_OFFLINE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let pending = '', errors = '', frameGroup = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        const chunk = /Chunk (\d+)\/(\d+):/.exec(line);
        if (chunk) {
          frameGroup = '第 ' + chunk[1] + '/' + chunk[2] + ' 组 · ';
          onProgress({ stage: 'SeedVR2 ' + frameGroup + '准备视频帧' });
        }
        const batch = /(Encoding|Upscaling|Decoding) batch (\d+)\/(\d+)/.exec(line);
        if (batch) {
          const phase = { Encoding: '编码', Upscaling: '增强', Decoding: '解码' }[batch[1]];
          onProgress({ stage: 'SeedVR2 ' + frameGroup + phase + ' ' + batch[2] + '/' + batch[3] + ' 批' });
        }
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-8000); });
    child.on('error', () => reject(Error('无法启动本地 SeedVR2 运行时。')));
    child.on('close', code => {
      if (code === 0) return resolve();
      if (/out of memory|not enough memory|paging file|1455/i.test(errors)) {
        return reject(Error('SeedVR2 显存或内存不足，请关闭占用 GPU 的程序后重试。'));
      }
      const kind = /\b(ModuleNotFoundError|ImportError|RuntimeError|ValueError|OSError|FileNotFoundError)\b/.exec(errors)?.[1];
      reject(Error('SeedVR2 本地推理失败（' + (kind || '退出码 ' + code) + '）。'));
    });
  });
}

async function seedRuntime(runtime) {
  const engine = path.join(runtime, 'engine');
  const python = path.join(runtime, 'venv', 'Scripts', 'python.exe');
  const modelDir = path.join(runtime, 'models');
  const cli = path.join(engine, 'inference_cli.py');
  try {
    await Promise.all([python, cli, path.join(modelDir, dit), path.join(modelDir, vae)].map(file => fs.access(file)));
  } catch {
    throw Error('SeedVR2 本地运行时或模型还没有安装。可以先使用常规本机放大。');
  }
  return { python, cli, modelDir };
}

async function upscaleSeedVR2(ffmpeg, { python, cli, modelDir }, source, output, onProgress = () => {}) {
  if (path.resolve(source).toLowerCase() === path.resolve(output).toLowerCase()) throw Error('请选择不同的输出文件。');
  const work = await fs.mkdtemp(path.join(path.dirname(output), '.duanju-seedvr2-'));
  try {
    const input = await probe(ffmpeg, source, work);
    if (!input.width || !input.height || !input.duration) throw Error('无法读取源视频。');
    const ai = path.join(work, 'ai.mp4');
    const muxed = path.join(work, 'final.mp4');
    // OpenCV on Windows may reject Unicode paths. Give it a local ASCII filename.
    await fs.copyFile(source, path.join(work, 'source.mp4'));
    onProgress({ stage: '正在加载 SeedVR2 3B，首次加载可能较慢' });
    await runSeed(python, [
      cli, 'source.mp4', '--output', 'ai.mp4', '--output_format', 'mp4', '--video_backend', 'ffmpeg',
      '--model_dir', modelDir, '--dit_model', dit, '--cuda_device', '0',
      '--resolution', '1080', '--max_resolution', '1920', '--batch_size', '5',
      '--chunk_size', '21', '--temporal_overlap', '2',
      '--dit_offload_device', 'cpu', '--vae_offload_device', 'cpu', '--tensor_offload_device', 'cpu',
      '--blocks_to_swap', '32', '--swap_io_components', '--cache_dit', '--cache_vae',
      '--vae_encode_tiled', '--vae_decode_tiled',
      '--vae_encode_tile_size', '512', '--vae_decode_tile_size', '512',
      '--vae_encode_tile_overlap', '64', '--vae_decode_tile_overlap', '64',
    ], work, ffmpeg, onProgress);
    const video = await probe(ffmpeg, ai, work);
    if (!video.width || !video.height || Math.abs(video.duration - input.duration) > 0.25) {
      throw Error('SeedVR2 输出不完整或时长与源视频不一致。');
    }
    onProgress({ stage: '正在封装 MP4 并保留原音轨' });
    await encode(ffmpeg, ['-i', ai, '-i', source, '-map', '0:v:0', '-map', '1:a?',
      '-c', 'copy', '-movflags', '+faststart', muxed], work, 'SeedVR2 封装');
    const result = await probe(ffmpeg, muxed, work);
    if (result.audio !== input.audio || Math.abs(result.duration - input.duration) > 0.25) {
      throw Error('SeedVR2 导出的时长或音轨与源视频不一致。');
    }
    await fs.rename(muxed, output);
    return result;
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { seedRuntime, upscaleSeedVR2 };
