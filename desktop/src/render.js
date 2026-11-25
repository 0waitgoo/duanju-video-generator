'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

function run(ffmpeg, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', ...args], { cwd, windowsHide: true });
    let output = '';
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-24000); });
    child.on('error', () => reject(Error('无法运行内置 FFmpeg。')));
    child.on('close', code => resolve({ code, output }));
  });
}
async function encode(ffmpeg, args, work, step) {
  const { code, output } = await run(ffmpeg, ['-loglevel', 'warning', '-y', ...args], work);
  if (code) {
    const detail = output.trim().split(/\r?\n/).slice(-3).join('\n');
    throw Error(step + '失败' + (detail ? '：' + detail : '。退出码 ' + code));
  }
}
async function probe(ffmpeg, file, cwd) {
  const { output } = await run(ffmpeg, ['-i', file], cwd);
  const size = /Stream[^\n]*Video:[^\n]*\b(\d{2,5})x(\d{2,5})\b/.exec(output);
  const duration = /Duration:\s+(\d+):(\d+):([\d.]+)/.exec(output);
  return {
    width: Number(size?.[1]), height: Number(size?.[2]), audio: /Stream[^\n]*Audio:/.test(output),
    duration: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : 0,
  };
}
const centiseconds = value => Math.round(value * 100);
function time(value) {
  const total = centiseconds(value);
  return Math.floor(total / 360000) + ':' +
    String(Math.floor(total / 6000) % 60).padStart(2, '0') + ':' +
    String(Math.floor(total / 100) % 60).padStart(2, '0') + '.' + String(total % 100).padStart(2, '0');
}
const assText = value => value
  .replace(/\\/g, '\\\u2060').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\r\n|\r|\n/g, '\\N');
function subtitleFile(shots, width, height) {
  let offset = 0;
  const events = [];
  for (const shot of shots) {
    const start = offset;
    offset += shot.durationSec;
    if (!shot.dialogue?.text?.trim()) continue;
    const line = (shot.dialogue.speaker ? shot.dialogue.speaker + '：' : '') + shot.dialogue.text;
    const style = 'Dialogue: 0,' + time(start) + ',' + time(offset) + ',Default,,0,0,0,,';
    events.push(style + assText(line));
  }
  return [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + width, 'PlayResY: ' + height, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes',
    '[V4+ Styles]', 'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Default,Microsoft YaHei,' + Math.max(13, Math.round(width * .052)) + ',&H00FFFFFF,&H000000FF,&H00101010,&H80000000,0,0,0,0,100,100,0,0,1,' +
      Math.max(1, Math.round(width * .0035)) + ',0,2,' + Math.round(width * .08) + ',' + Math.round(width * .08) + ',' + Math.round(height * .11) + ',1',
    '[Events]', 'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text', ...events, '',
  ].join('\n');
}

const EFFECTS = [
  [/爆炸|撞击|地震|轰|砸|低频|撞|砰/, 'impact'],
  [/脚步|奔跑|跳|敲|按键|推门|碰撞|门铃/, 'click'],
  [/风|车流|行驶|广播|环境|人群|人声|嘈杂|空气|呼啸|雷|雨/, 'air'],
  [/提示|电子|电流|电视|警报|铃|喇叭|蜂鸣/, 'tone'],
  [/玻璃|金属|摩擦|撕|碎|衣料/, 'texture'],
  [/心跳|紧张|悬念|音乐|配乐|音效/, 'pulse'],
];
function effectFor(label) {
  if (!label || /^(无|静默|静音|无音效)[。.]?$/.test(label.trim())) return '';
  return EFFECTS.find(([pattern]) => pattern.test(label))?.[1] || 'texture';
}
function soundTrack(shots, duration) {
  const rate = 24000;
  const length = Math.ceil(duration * rate);
  const samples = Buffer.alloc(44 + length * 2);
  samples.write('RIFF'); samples.writeUInt32LE(samples.length - 8, 4); samples.write('WAVEfmt ', 8);
  samples.writeUInt32LE(16, 16); samples.writeUInt16LE(1, 20); samples.writeUInt16LE(1, 22);
  samples.writeUInt32LE(rate, 24); samples.writeUInt32LE(rate * 2, 28); samples.writeUInt16LE(2, 32);
  samples.writeUInt16LE(16, 34); samples.write('data', 36); samples.writeUInt32LE(length * 2, 40);
  let offset = 0;
  for (const shot of shots) {
    const mode = effectFor(shot.sfx);
    const start = Math.round(offset * rate);
    offset += shot.durationSec;
    if (!mode) continue;
    let noise = 0;
    let seed = shot.shotIndex * 727 + 19;
    const stop = Math.min(length, Math.round(offset * rate));
    for (let i = start; i < stop; i++) {
      const t = (i - start) / rate;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const white = seed / 2147483648 - 1;
      noise = noise * .92 + white * .08;
      const wave = (frequency, at = t) => Math.sin(2 * Math.PI * frequency * at);
      const envelope = Math.min(1, t * 50, (stop - i) / 650);
      const signal = {
        impact: () => (.58 * wave(50) + .42 * noise) * Math.exp(-2.6 * t),
        click: () => (noise * 1.5 + .35 * wave(130)) * Math.exp(-30 * (t % .52)),
        air: () => noise * (1 + .24 * wave(.7)),
        tone: () => (wave(515) + .3 * wave(1030)) * Math.exp(-7 * (t % 1.3)) * .47,
        texture: () => (white * .48 + noise) * Math.exp(-4 * t),
        pulse: () => wave(70) * Math.exp(-10 * (t % .8)) * .42,
      }[mode]();
      samples.writeInt16LE(Math.round(signal * envelope * 6400), 44 + i * 2);
    }
  }
  return samples;
}
function outputSize(source, ratio, resolution) {
  const [a, b] = ratio.split(':').map(Number);
  if (!a || !b || Math.abs(source.width / source.height - a / b) < .01) {
    return [source.width & ~1, source.height & ~1];
  }
  const short = resolution === '2K' ? 1152 : 768;
  return a < b ? [short, Math.round(short * b / a / 2) * 2] : [Math.round(short * a / b / 2) * 2, short];
}

async function assemble({ ffmpeg, output, clips, settings, music, onStage = () => {} }) {
  if (!clips.length) throw Error('没有可拼接的子段。');
  const work = await fs.mkdtemp(path.join(path.dirname(output), 'render-'));
  const first = await probe(ffmpeg, clips[0].file, work);
  if (!first.width) {
    await fs.rm(work, { recursive: true, force: true });
    throw Error('子段 ' + clips[0].id + ' 没有可读取的视频流。');
  }
  const [w, h] = outputSize(first, settings.ratio, settings.resolution);
  const fragments = [];
  const dissolve = settings.transition === 'dissolve';
  const normalize = 'scale=' + w + ':' + h + ':force_original_aspect_ratio=increase,crop=' + w + ':' + h + ',setsar=1,fps=30';
  const videoCodec = ['-c:v', 'libx264', '-threads', '4', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p'];
  let total = 0;
  try {
    for (const [index, clip] of clips.entries()) {
      onStage('正在拼接子段 ' + (index + 1) + '/' + clips.length);
      const media = index ? await probe(ffmpeg, clip.file, work) : first;
      if (!media.width || !media.duration) throw Error('子段 ' + clip.id + ' 文件不完整，请单独重试下载。');
      const frames = Math.max(1, Math.round((total + clip.seconds) * 30) - Math.round(total * 30));
      total += clip.seconds;
      const duration = frames / 30;
      const name = 'part-' + index + '.mp4';
      const args = ['-filter_complex_threads', '2', '-i', clip.file];
      if (index && dissolve) args.push('-loop', '1', '-framerate', '30', '-i', 'tail.png');
      const audioIndex = index && dissolve ? 2 : 1;
      if (settings.effects) {
        await fs.writeFile(path.join(work, 'effects.wav'), soundTrack(clip.shots, duration));
        args.push('-i', 'effects.wav');
      }
      const options = media.duration < duration - .2 ? 'tpad=stop_mode=clone:stop_duration=' + duration : 'tpad=stop_mode=clone:stop_duration=.25';
      const chain = ['[0:v]' + normalize + ',' + options.replace('=.25', '=0.25') + ',trim=end_frame=' + frames + ',setpts=PTS-STARTPTS[v]'];
      if (index && dissolve) {
        chain.push('[1:v]format=rgba,fade=t=out:st=0:d=0.2:alpha=1[tail]');
        chain.push('[v][tail]overlay=enable=between(t\\,0\\,0.2)[mix]');
      }
      await fs.writeFile(path.join(work, 'captions.ass'), subtitleFile(clip.shots, w, h), 'utf8');
      chain.push((index && dissolve ? '[mix]' : '[v]') + (settings.subtitles === false ? 'null' : 'ass=filename=captions.ass') + '[out]');
      const baseAudio = media.audio && settings.nativeAudio !== false ? '[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=duration=' + duration + '[bed]' :
        'anullsrc=r=48000:cl=stereo,atrim=duration=' + duration + '[bed]';
      chain.push(baseAudio);
      if (settings.effects) {
        chain.push('[' + audioIndex + ':a]aresample=48000,aformat=channel_layouts=stereo[fx]');
        chain.push('[bed][fx]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]');
      }
      args.push('-filter_complex', chain.join(';'), '-map', '[out]', '-map', settings.effects ? '[a]' : '[bed]',
        ...videoCodec, '-c:a', 'aac', '-ac', '2', '-ar', '48000', '-t', String(duration), name);
      await encode(ffmpeg, args, work, '子段 ' + clip.id + ' 合成');
      fragments.push(name);
      if (dissolve && index < clips.length - 1) {
        const tailTime = Math.max(0, Math.min(media.duration, duration) - .08);
        await encode(ffmpeg, ['-ss', String(tailTime), '-i', clip.file, '-an', '-vf',
          normalize + ',format=rgb24', '-frames:v', '1', '-update', '1', 'tail-next.png'], work, '转场尾帧提取');
        await fs.rename(path.join(work, 'tail-next.png'), path.join(work, 'tail.png'));
      }
    }
    await fs.writeFile(path.join(work, 'concat.txt'), fragments.map(name => "file '" + name + "'").join('\n'));
    onStage('正在写入整集 MP4');
    const args = ['-f', 'concat', '-safe', '1', '-i', 'concat.txt'];
    if (music) {
      args.push('-stream_loop', '-1', '-i', music, '-filter_complex',
        '[1:a]volume=' + ((settings.musicVolume ?? 20) / 100) + '[music];[0:a][music]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95:latency=1[a]',
        '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k');
    }
    args.push('-movflags', '+faststart', 'episode.mp4');
    await encode(ffmpeg, args, work, '整集导出');
    const result = path.join(work, 'episode.mp4');
    const meta = await probe(ffmpeg, result, work);
    const { size } = await fs.stat(result);
    if (!meta.width || !meta.duration || !size) throw Error('整集输出无法读取。');
    await fs.rename(result, output);
    return { ...meta, size };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
async function upscaleEpisode(ffmpeg, source, output) {
  const work = path.dirname(output);
  if (path.resolve(source).toLowerCase() === path.resolve(output).toLowerCase()) throw Error('请选择不同的输出文件。');
  const input = await probe(ffmpeg, source, work);
  if (!input.width || !input.height || !input.duration) throw Error('无法读取整集视频。');
  const portrait = input.height >= input.width;
  const width = portrait ? 1080 : 1920;
  const height = portrait ? 1920 : 1080;
  if (Math.min(width / input.width, height / input.height) <= 1) throw Error('成片已达到这个高清尺寸，建议保存原文件。');
  const temp = path.join(work, '.duanju-' + randomUUID() + '.mp4');
  try {
    await encode(ffmpeg, ['-i', source, '-map', '0:v:0', '-map', '0:a?', '-vf',
      'scale=' + width + ':' + height + ':flags=lanczos:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1',
      '-c:v', 'libx264', '-threads', '4', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'copy', '-movflags', '+faststart', temp], work, '本地高清导出');
    const meta = await probe(ffmpeg, temp, work);
    if (!meta.width || !meta.height || !meta.duration) throw Error('高清文件无法读取。');
    await fs.rename(temp, output);
    return meta;
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}
module.exports = { assemble, effectFor, probe, soundTrack, subtitleFile, upscaleEpisode };

