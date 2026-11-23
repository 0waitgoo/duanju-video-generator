'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');
const { randomUUID } = require('node:crypto');
const yauzl = require('yauzl');
const { imageSize } = require('image-size');
const { parse } = require('csv-parse/sync');

const GRID = ['左上', '右上', '左下', '右下'];
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const imageType = file => IMAGE_TYPES[path.extname(file).toLowerCase()];
const seconds = shots => shots.reduce((sum, shot) => sum + shot.durationSec, 0);
const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];
function safeImage(name) {
  return typeof name === 'string' && /^images\//.test(name) && imageType(name) &&
    name.split('/').every(part => part && !/^(?:\.{1,2}|(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?)$/i.test(part)
      && !/[\\:<>"|?*\u0000-\u001f]|[. ]$/.test(part));
}
function normalize(raw) {
  if (typeof raw?.format !== 'string' || raw.format.toLowerCase() !== 'duanju-canvas-export') throw Error('这不是画布导出包，格式名应为 duanju-canvas-export。');
  if (raw.version !== 1) throw Error('导出包版本不支持，目前支持 v1。');
  if (!Array.isArray(raw.segments) && Array.isArray(raw.scripts?.[0]?.segments)) {
    const script = raw.scripts[0];
    raw = { ...raw, canvasId: String(raw.project?.id ?? ''), canvasName: raw.project?.title,
      scriptText: script.scriptText, globalSetup: script.globalSetup,
      characters: list(raw.characters).map(item => ({ ...item, description: item.description ?? item.appearance, image: item.image ?? item.portraitFile })),
      assets: list(raw.assets).map(item => ({ ...item, image: item.image ?? item.imageFile, kind: item.kind ?? item.categoryLabel })),
      segments: script.segments.map(segment => ({ ...segment, index: segment.index ?? segment.segment,
        gridImage: segment.gridImage ?? segment.imageFile,
        shots: list(segment.shots).map(shot => ({ ...shot, shotIndex: shot.shotIndex ?? shot.shot,
          camera: shot.camera ?? shot.cameraNote, charIds: shot.charIds ?? shot.characterIds,
          dialogue: typeof shot.dialogue === 'string' ? (/^\s*[（(]?无台词[）)]?\s*$/.test(shot.dialogue) || !shot.dialogue ? null : { speaker: '', text: shot.dialogue }) : shot.dialogue })) })) };
  }
  if (!Array.isArray(raw.segments)) throw Error('project.json 的 segments 不是数组。');
  if (!raw.segments.length) throw Error('这个画布还没有分镜，请先在画布里点一键分析。');
  const library = (entries, kind) => list(entries).filter(item => text(item?.name)).map(item => ({
    id: String(item.id ?? item.name), name: item.name, description: text(item.description),
    image: text(item.image), kind: kind || text(item.kind) || '道具', style: text(item.style),
  }));
  let last = 0;
  const segments = raw.segments.map((segment, index) => {
    if (!segment || Number(segment.index) !== index + 1 || !Array.isArray(segment.shots) ||
        segment.shots.length < 1 || segment.shots.length > 4) throw Error('第 ' + (index + 1) + ' 段的段号或镜数无效。');
    return {
      index: index + 1, title: text(segment.title), setup: text(segment.setup), voices: text(segment.voices),
      endCard: text(segment.endCard), gridImage: text(segment.gridImage),
      shots: segment.shots.map((shot, cell) => {
        if (!shot || Number(shot.shotIndex) !== ++last) throw Error('镜号不连续，应为第 ' + last + ' 镜。');
        const durationSec = Number(shot.durationSec ?? shot.duration ?? shot.videoSec);
        return {
          shotIndex: last, cell, durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 0,
          startSec: shot.startSec ?? null, endSec: shot.endSec ?? null,
          framing: text(shot.framing), camera: text(shot.camera), visual: text(shot.visual), sfx: text(shot.sfx),
          prompt: text(shot.prompt || shot.videoPrompt), charIds: list(shot.charIds).map(String),
          assetIds: list(shot.assetIds).map(String), hasDialogue: shot.hasDialogue === true || shot.dialogue != null,
          dialogue: typeof shot.dialogue?.text === 'string' ?
            { speaker: text(shot.dialogue.speaker), text: shot.dialogue.text } : null,
        };
      }),
    };
  });
  const scriptText = text(raw.scriptText);
  return {
    format: raw.format, version: raw.version, id: randomUUID(), canvasId: text(raw.canvasId),
    canvasName: text(raw.canvasName) || '未命名画布',
    title: text(raw.scriptTitle) || scriptText.split(/\r?\n/).find(line => line.trim())?.replace(/^#+\s*/, '').slice(0, 120) || '未命名剧集',
    scriptText, globalSetup: text(raw.globalSetup), segments,
    characters: library(raw.characters, '人物'), scenes: library(raw.scenes, '场景'), assets: library(raw.assets),
  };
}

function bindings(project, shots) {
  const words = shots.flatMap(shot => [shot.visual, shot.prompt, shot.dialogue?.speaker, shot.dialogue?.text]).join('\n');
  const locked = new Set(shots.flatMap(shot => shot.assetIds));
  return {
    characters: project.characters.filter(item => words.includes(item.name)),
    assets: [...project.scenes, ...project.assets].filter(item =>
      words.includes(item.name) || (item.kind === '场景' && locked.has(item.id))),
  };
}

function plan(segment) {
  const total = seconds(segment.shots);
  const label = '第 ' + segment.index + ' 段';
  if (segment.shots.some(shot => shot.durationSec <= 0 || shot.durationSec > 10)) throw Error(label + '的单镜时长须大于 0 且不超过 10 秒。');
  if (segment.shots.length < 2) throw Error(label + '只有一镜，无法生成。请在画布中与同场镜头重新分段后导出。');
  let groups = [segment.shots];
  if (total > 15) {
    groups = [segment.shots.slice(0, 2), segment.shots.slice(2)];
    if (Math.ceil(total / 15) !== 2 || groups.some(group => group.length < 2 || seconds(group) > 15)) {
      throw Error(label + '无法同时满足每子段至少两镜且不超过 15 秒。请在画布内调整时长后重新导出。');
    }
  }
  return groups.map((shots, index) => ({
    id: segment.index + '-' + (index + 1), segment: segment.index, index, count: groups.length,
    shots, seconds: seconds(shots), duration: Math.max(4, Math.ceil(seconds(shots))),
  }));
}

function prompt(project, segment, part, edits = {}) {
  const { characters, assets } = bindings(project, part.shots);
  const inactive = project.characters.filter(item => !characters.includes(item));
  const filterPeople = value => value.replace(/([^；;\n]*[；;\n]?)/g, chunk => {
    if (!inactive.some(item => chunk.includes(item.name))) return chunk;
    const mentioned = characters.filter(item => chunk.includes(item.name));
    if (/^\s*人物[：:]/.test(chunk)) return mentioned.length ? '人物：' + mentioned.map(item => item.name).join('、') + '；' : '';
    return '';
  });
  const restrictAssets = value => value.replace(/(^|[；;\n])(场景|道具)[：:]([^；;\n]*)/g, (entry, prefix, kind, body) => {
    const catalog = kind === '场景' ? project.scenes : project.assets;
    if (!catalog.some(item => body.includes(item.name) && !assets.includes(item))) return entry;
    const selected = body.split(/[、，,]/).filter(chunk =>
      !catalog.some(item => chunk.includes(item.name) && !assets.includes(item)));
    return selected.length ? prefix + kind + '：' + selected.join('、') : prefix;
  });
  const filterSetup = value => restrictAssets(filterPeople(value))
    .replace(/人数[：:]共?\s*\d+\s*人/g, '人数：共' + characters.length + '人');
  const grid = '格位对照：' + part.shots.map(shot => GRID[shot.cell] + '→分镜' + shot.shotIndex).join('，');
  let offset = 0;
  const lines = part.shots.map(shot => {
    const start = offset;
    offset += shot.durationSec;
    const span = '[' + Number(start.toFixed(3)) + '-' + Number(offset.toFixed(3)) + '秒]';
    const dynamics = Object.hasOwn(edits, shot.shotIndex)
      ? filterPeople(edits[shot.shotIndex]) : [shot.camera, shot.visual, shot.prompt].filter(Boolean).join('；');
    const dialogue = shot.dialogue?.text?.trim()
      ? '台词「' + (shot.dialogue.speaker ? shot.dialogue.speaker + '：' : '') + shot.dialogue.text + '」' : '无台词（静默）';
    return '分镜' + shot.shotIndex + ' ' + span + ' [' + shot.framing + '] ' + dynamics + '；' + dialogue
      + (shot.sfx ? '；音效：' + shot.sfx : '');
  });
  return [filterSetup(project.globalSetup), filterSetup(segment.setup), filterPeople(segment.voices),
    assets.length ? '资产锁：' + assets.map(item => [item.name, item.description, item.style].filter(Boolean).join('｜')).join('；') : '',
    grid, '第' + segment.index + '段／共' + project.segments.length + '段'
      + (part.count > 1 ? '（第' + (part.index + 1) + '部分／共' + part.count + '部分）' : '') + '，时长约' + part.seconds + '秒',
    ...lines, '台词严格照原文逐字说，禁止增删、合并或改写。无台词的镜保持静默。', restrictAssets(filterPeople(segment.endCard))].filter(Boolean).join('\n');
}

function inspect(project) {
  const issues = [];
  const missing = new Set();
  const sizes = project.images;
  const add = (level, segment, shot, message) => issues.push({ level, segment, shot, message });
  const check = (file, label, segment, level = 'red') => {
    if (!file || !Object.hasOwn(sizes, file) || !sizes[file].valid) {
      if (!file || !Object.hasOwn(sizes, file)) missing.add(file || label);
      add(level, segment, null, label + (file ? ' · ' + file : '') + ' 缺失或不可读');
    } else if (sizes[file].width < 16 || sizes[file].height < 16) {
      add('yellow', segment, null, label + '疑似占位图 · ' + file);
    }
  };
  for (const segment of project.segments) {
    check(segment.gridImage, '四宫格图', segment.index);
    for (const item of Object.values(bindings(project, segment.shots)).flat()) check(item.image, item.name + '参考图', segment.index);
    try { plan(segment); } catch (error) { add('red', segment.index, null, error.message); }
    for (const shot of segment.shots) {
      if (shot.hasDialogue && !shot.dialogue?.text?.trim()) add('red', segment.index, shot.shotIndex, '标注有台词，原文为空');
      if (!shot.durationSec) add('red', segment.index, shot.shotIndex, '镜头时长为 0');
      if (!shot.sfx) add('yellow', segment.index, shot.shotIndex, '未填写音效');
      const actual = bindings(project, [shot]).characters.map(item => item.id);
      if (shot.charIds.length && (shot.charIds.some(id => !actual.includes(id)) || actual.some(id => !shot.charIds.includes(id)))) {
        add('yellow', segment.index, shot.shotIndex, '原始人物标记与镜内点名有差异，采用点名结果');
      }
    }
  }
  for (const item of [...project.characters, ...project.assets, ...project.scenes]) {
    if (item.image && !Object.hasOwn(sizes, item.image)) missing.add(item.image);
  }
  return { issues, missing: [...missing] };
}


async function readProjectZip(file, dir) {
  const diagnostic = { path: null, format: null, version: null, rawSegments: null, segments: [], filtered: [], missing: [] };
  let zip;
  try {
    const stat = await fs.stat(file);
    if (stat.size > 1536 * 1024 ** 2) throw Error('ZIP 超过 1.5 GB。请按集导出。');
    zip = await yauzl.openPromise(file, { validateEntrySizes: true, strictFileNames: true, autoClose: false });
    const entries = [];
    for await (const entry of zip.eachEntry()) entries.push(entry);
    const manifests = entries.filter(entry => /(^|\/)project\.json$/i.test(entry.fileName) &&
      entry.fileName.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes('\\')));
    manifests.sort((a, b) => (a.fileName.toLowerCase() === 'project.json' ? -1 : b.fileName.toLowerCase() === 'project.json' ? 1 : a.fileName.localeCompare(b.fileName)));
    const manifest = manifests[0];
    if (!manifest) throw Error('这不是画布导出包，ZIP 中没有 project.json。');
    diagnostic.path = manifest.fileName;
    diagnostic.candidates = manifests.map(entry => entry.fileName);
    if (manifest.uncompressedSize > 8 * 1024 ** 2) throw Error('project.json 超过 8 MB。');
    const chunks = [];
    for await (const chunk of await zip.openReadStreamPromise(manifest)) chunks.push(chunk);
    let raw;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '')); }
    catch { throw Error('project.json 解析失败，请从画布重新导出。'); }
    diagnostic.format = raw?.format ?? null;
    diagnostic.version = raw?.version ?? null;
    const inputSegments = Array.isArray(raw?.segments) ? raw.segments : raw?.scripts?.[0]?.segments;
    diagnostic.segmentPath = Array.isArray(raw?.segments) ? 'segments' : 'scripts[0].segments';
    diagnostic.rawSegments = Array.isArray(inputSegments) ? inputSegments.length : null;
    if (Array.isArray(inputSegments)) {
      diagnostic.segments = inputSegments.map((segment, index) => ({
        index: segment?.index ?? segment?.segment ?? index + 1, shots: Array.isArray(segment?.shots) ? segment.shots.length : null,
      }));
      let last = 0;
      inputSegments.forEach((segment, index) => {
        if (!segment || Number(segment.index ?? segment.segment) !== index + 1 || !Array.isArray(segment.shots) || segment.shots.length < 1 || segment.shots.length > 4) {
          diagnostic.filtered.push('第 ' + (index + 1) + ' 段的段号或镜数无效，整个导入被拒绝。');
        }
        if (Array.isArray(segment?.shots)) segment.shots.forEach(shot => {
          last++;
          if (!shot || Number(shot.shotIndex ?? shot.shot) !== last) diagnostic.filtered.push('第 ' + (index + 1) + ' 段第 ' + last + ' 镜的镜号无效，整个导入被拒绝。');
        });
      });
    }
    const project = normalize(raw);
    const prefix = manifest.fileName.slice(0, manifest.fileName.lastIndexOf('/') + 1);
    const images = Object.create(null);
    const seen = new Set();
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.fileName.startsWith(prefix)) continue;
      const name = entry.fileName.slice(prefix.length);
      if (!safeImage(name)) continue;
      if (seen.has(name.toLowerCase())) throw Error('ZIP 中存在重复图片：' + name);
      seen.add(name.toLowerCase());
      bytes += entry.uncompressedSize;
      if (entry.uncompressedSize > 30 * 1024 ** 2 || bytes > 1536 * 1024 ** 2) throw Error('包内图片超过大小限制：' + name);
      const dest = path.join(dir, name);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(dest, { flags: 'wx' }));
      try {
        const { width, height, type } = imageSize(await fs.readFile(dest));
        images[name] = { width, height, valid: imageType(name) === 'image/' + (type === 'jpg' ? 'jpeg' : type) };
      } catch { images[name] = { valid: false }; }
    }
    project.images = images;
    project.check = inspect(project);
    diagnostic.missing = project.check.missing;
    project.diagnostic = diagnostic;
    return project;
  } catch (error) {
    error.diagnostic = diagnostic;
    throw error;
  } finally { if (zip?.isOpen) zip.close(); }
}

function readStoryboard(csv) {
  const rows = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true });
  const headers = ['镜号', '时长（秒）', '景别', '画面内容', '台词', '音效 / 音乐', '镜头说明'];
  if (!headers.every((column, index) => rows[0]?.[index] === column)) throw Error('分镜表表头与交接规范不一致。');
  const scenes = [];
  for (const row of rows.slice(1)) {
    if (row.length === 1 && /^（内容由AI生成）\s*$/.test(row[0])) continue;
    if (row.length !== headers.length) throw Error('分镜表列数无效：' + row[0]);
    const [index, duration, framing, visual, line, sfx, camera] = row;
    if (!row.slice(1).some(Boolean)) {
      scenes.push({ name: index, shots: [] });
      continue;
    }
    const match = /^([^：:（）(]+)(?:（[^）]*）|\([^)]*\))?[：:]([\s\S]*)$/.exec(line);
    const dialogue = line === '无' || line === '' ? null : match ?
      { speaker: match[1], text: match[2] } : { speaker: '', text: line };
    if (!scenes.length || Number(index) !== scenes.flatMap(scene => scene.shots).length + 1 || !(Number(duration) > 0)) {
      throw Error('分镜表镜号或时长无效：' + index);
    }
    scenes.at(-1).shots.push({ shotIndex: Number(index), durationSec: Number(duration), framing, visual, dialogue, line, sfx, camera });
  }
  return scenes;
}

module.exports = { bindings, imageType, inspect, normalize, plan, prompt, readProjectZip, readStoryboard, seconds, safeImage };

