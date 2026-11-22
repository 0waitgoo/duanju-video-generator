'use strict';
/**
 * importer.js — 读入画布「导出项目」的 ZIP 包。
 *
 * 包格式（已定）：ZIP 内含 project.json ＋ images/ 文件夹。
 *   project.json：format = "duanju-canvas-export"、version = 1，
 *     剧本全文、每段整体设定/音色描述/结尾状态卡、每镜台词/时长/景别/运镜/音效、
 *     人物/场景/道具库、每镜绑定关系（名字和 id 双份）。
 *   images/：四宫格图原图按段命名（segment-01-shots-1-4）、定妆照 images/characters/、
 *     资源设定图 images/assets/，真实文件不转 base64。
 *
 * 导入时校验格式名和版本；重复导入同一画布（按 canvasId / 画布名识别）整包替换。
 * 画布导出字段名以英文为主，这里做宽容归一化（同时认几种常见写法）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const EXPORT_FORMAT = 'duanju-canvas-export';
const EXPORT_VERSION = 1;

function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function asText(v) {
  if (v === undefined || v === null) return '';
  return String(v);
}

function normalizeDialogue(d) {
  if (!d) return null;
  if (typeof d === 'string') {
    const text = d.trim();
    return text ? { speaker: '', text } : null;
  }
  const text = asText(d.text || d.content || d.line).trim();
  if (!text) return null;
  return { speaker: asText(d.speaker || d.role || d.name), text };
}

function normalizeShot(raw, index) {
  const shotIndex = Number(pick(raw, 'shotIndex', 'index', '镜号', 'shot')) || index + 1;
  return {
    shotIndex,
    startSec: pick(raw, 'startSec', 'start', '开始秒') ?? null,
    endSec: pick(raw, 'endSec', 'end', '结束秒') ?? null,
    durationSec: Number(pick(raw, 'durationSec', 'duration', 'videoSec', '时长', '时长（秒）')) || 0,
    framing: asText(pick(raw, 'framing', '景别')),
    camera: asText(pick(raw, 'camera', 'cameraNote', '运镜', '镜头说明')),
    visual: asText(pick(raw, 'visual', 'picture', '画面', '画面内容')),
    dialogue: normalizeDialogue(pick(raw, 'dialogue', '台词')),
    sfx: asText(pick(raw, 'sfx', 'sound', '音效', '音效 / 音乐')),
    charIds: (pick(raw, 'charIds', 'characters', 'characterIds', '人物') || []).map(String),
    assetIds: (pick(raw, 'assetIds', 'assets', 'asset', '场景道具') || []).map(String),
  };
}

function normalizeSegment(raw, index) {
  const shots = (pick(raw, 'shots', '分镜') || []).map((s, i) => normalizeShot(s, i));
  return {
    index: Number(pick(raw, 'index', 'segIndex', '段号')) || index + 1,
    title: asText(pick(raw, 'title', 'name', '段标题')),
    setup: asText(pick(raw, 'setup', 'segSetup', '段设定', '整体设定')),
    voices: asText(pick(raw, 'voices', 'voiceDesc', 'voice', '音色', '角色音色描述')),
    endCard: asText(pick(raw, 'endCard', 'endState', '结尾状态卡', '本段结尾状态卡')),
    gridImage: asText(pick(raw, 'gridImage', 'image', '图')),
    shots,
  };
}

function normalizeLibrary(list, kind) {
  return (list || []).map((raw, i) => ({
    id: String(pick(raw, 'id', 'name') ?? `${kind}-${i + 1}`),
    name: asText(pick(raw, 'name', '名称')),
    kind: asText(pick(raw, 'kind', 'category', '分类')) || kind,
    description: asText(pick(raw, 'description', 'desc', '描述', '外貌', 'appearance')),
    image: asText(pick(raw, 'image', 'portrait', 'imagePath', '定妆照')),
  }));
}

/** 把 project.json 归一化成内部结构；字段缺失时给空值，不抛错。 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('project.json 内容无效');
  const format = pick(raw, 'format', 'formatName', '格式名');
  if (format !== EXPORT_FORMAT) {
    throw new Error(`不是画布导出包：期望格式名 ${EXPORT_FORMAT}，实际为 ${format || '（缺失）'}`);
  }
  const version = Number(pick(raw, 'version', '版本'));
  if (version !== EXPORT_VERSION) {
    throw new Error(`导出包版本不支持：期望版本 ${EXPORT_VERSION}，实际为 ${Number.isNaN(version) ? '（缺失）' : version}`);
  }
  const segments = (pick(raw, 'segments', '段落') || []).map((s, i) => normalizeSegment(s, i));
  const scriptText = asText(pick(raw, 'scriptText', 'script', '剧本', '剧本全文'));
  const canvasName = asText(pick(raw, 'canvasName', 'canvas', 'projectName', '画布名')) || '未命名画布';
  const canvasId = asText(pick(raw, 'canvasId', 'id')) || crypto.createHash('md5').update(scriptText).digest('hex').slice(0, 12);
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    id: canvasId,
    canvasName,
    scriptText,
    globalSetup: asText(pick(raw, 'globalSetup', 'overallSetup', '整体设定')),
    characters: normalizeLibrary(pick(raw, 'characters', '人物', 'cast'), '人物'),
    scenes: normalizeLibrary(pick(raw, 'scenes', '场景'), '场景'),
    assets: normalizeLibrary(pick(raw, 'assets', 'props', '道具'), '道具'),
    segments,
  };
}

function safeEntryPath(name) {
  const clean = name.replace(/\\/g, '/');
  if (clean.startsWith('/') || clean.includes('..')) return null;
  return clean;
}

/**
 * 导入 ZIP：校验并解包到 dataDir/projects/<id>/，返回归一化后的项目。
 * 同一画布（相同 id）重复导入时整包替换：先删旧目录再解包。
 */
function importZip(zipPath, projectsDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  const manifestEntry = entries.find((e) => {
    const p = safeEntryPath(e.entryName);
    return p && (p === 'project.json' || p.endsWith('/project.json'));
  });
  if (!manifestEntry) throw new Error('ZIP 包里找不到 project.json，不是画布导出包');
  let raw;
  try {
    raw = JSON.parse(zip.readAsText(manifestEntry));
  } catch (e) {
    throw new Error('project.json 解析失败：' + e.message);
  }
  const project = normalizeProject(raw);
  const destDir = path.join(projectsDir, project.id);
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  let imageCount = 0;
  const missing = [];
  for (const entry of entries) {
    const rel = safeEntryPath(entry.entryName);
    if (!rel) continue;
    const dest = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
    if (/\.(png|jpe?g|webp|gif)$/i.test(rel)) imageCount += 1;
  }
  // 核对清单里引用的图片是否都在包里
  const referenced = new Set();
  for (const seg of project.segments) {
    if (seg.gridImage) referenced.add(seg.gridImage);
    for (const s of seg.shots) {
      // 绑定的人物/场景图片按库里的 image 字段核对
    }
  }
  for (const lib of [...project.characters, ...project.scenes, ...project.assets]) {
    if (lib.image) referenced.add(lib.image);
  }
  for (const rel of referenced) {
    if (!fs.existsSync(path.join(destDir, rel))) missing.push(rel);
  }
  project.imageCount = imageCount;
  project.missingImages = missing;
  project.importedAt = new Date().toISOString();
  fs.writeFileSync(path.join(destDir, 'project.normalized.json'), JSON.stringify(project, null, 2));
  return project;
}

module.exports = { importZip, normalizeProject, EXPORT_FORMAT, EXPORT_VERSION };
