'use strict';
/**
 * store.js — 极简 JSON 文件持久化。
 * 所有运行时数据（设置、项目、任务）只存在本机 data/ 目录，绝不进仓库。
 * API Key 只存 data/settings.json，接口返回时一律只露末 4 位。
 */
const fs = require('node:fs');
const path = require('node:path');

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

module.exports = { loadJson, saveJson, maskKey };
