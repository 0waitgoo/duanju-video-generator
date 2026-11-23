'use strict';
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { imageType } = require('./project');

const BASES = ['https://api.minimax.io', 'https://api.minimax.cn'];
const DEEPSEEK = 'https://api.deepseek.com';
class ProviderError extends Error {
  constructor(message, code, status, ambiguous = false) {
    super(message);
    Object.assign(this, { code, status, ambiguous });
  }
}
const isAuth = error => error.status === 401 || ['1004', '2049'].includes(String(error.code));
const isExpired = error => String(error.code) === '2013';
async function json(url, key, body) {
  let response;
  try {
    response = await fetch(url, {
      method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body, signal: AbortSignal.timeout(body ? 90000 : 30000),
    });
  } catch {
    throw new ProviderError('连接超时或网络中断，请检查网络。', 'NETWORK', null, Boolean(body));
  }
  const data = await response.json().catch(() => null);
  const miniCode = !url.startsWith(DEEPSEEK) ? /\((\d{4})\)\s*$/.exec(data?.error?.message || '')?.[1] : null;
  const taskMissing = response.status === 404 && url.includes('/v2/query/video_generation/');
  const code = data?.base_resp?.status_code ?? data?.error?.code ?? miniCode ?? (taskMissing ? 2013 : null);
  if (!response.ok || (code != null && Number(code) !== 0)) {
    const safeCode = /^[a-zA-Z0-9_-]{1,64}$/.test(String(code)) && code != null ? code : response.status;
    const error = new ProviderError('接口拒绝请求', safeCode, response.status, Boolean(body) && response.status >= 500);
    if (isAuth(error)) error.message = url.startsWith(DEEPSEEK)
      ? 'DeepSeek 鉴权失败，请检查 Key。' : 'MiniMax 鉴权失败，请检查 Key、站点及按量付费权限。';
    else if (url.includes('/v2/query/video_generation/') && isExpired(error)) error.message = '远端任务已过期，可重新提交此子段。';
    else if (response.status === 400) error.message = '请求参数无效，请检查参考图尺寸和提示词。';
    else if (response.status === 422) error.message = '服务商拒绝处理此素材，请检查内容和参考图。';
    else if (response.status === 429) error.message = '接口限流或额度不足，请检查额度后重试。';
    else if (response.status === 402) error.message = '余额或额度不足，请检查服务商账户。';
    throw error;
  }
  if (!data) throw new ProviderError('接口响应无法解析。', 'RESPONSE', response.status, Boolean(body));
  return data;
}

async function prepare(settings, text, references, duration) {
  if (references.length < 1 || references.length > 9) throw Error('每个子段需要 1–9 张参考图，当前有 ' + references.length + ' 张。');
  if ([...text].length > 7000) throw Error('提示词超过 MiniMax 的 7000 字符限制。');
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) throw Error('MiniMax 提交时长必须在 4–15 秒内。');
  const content = [{ type: 'text', text }];
  let encodedBytes = Buffer.byteLength(text);
  for (const file of references) {
    const size = (await fs.stat(file)).size;
    if (size > 30 * 1024 ** 2) throw Error('单张参考图超过 30 MB。');
    encodedBytes += Math.ceil(size / 3) * 4;
    if (encodedBytes > 64 * 1024 ** 2) throw Error('参考图编码后超过 64 MB 请求体限制。');
    const image_url = 'data:' + imageType(file) + ';base64,' + (await fs.readFile(file)).toString('base64');
    content.push({ type: 'image_url', image_url, role: 'reference_image' });
  }
  const body = JSON.stringify({
    model: 'MiniMax-H3', content, duration, resolution: settings.resolution,
    ratio: settings.ratio, generate_audio: settings.generateAudio,
  });
  if (Buffer.byteLength(body) > 64 * 1024 ** 2) throw Error('请求体超过 64 MB。');
  return body;
}

async function create(settings, key, body) {
  const data = await json(settings.base + '/v2/video_generation', key, body);
  const id = data.task_id ?? data.id ?? data.task?.id ?? data.task?.task_id;
  if (!id) throw new ProviderError('创建响应缺少任务编号，请先在 MiniMax 核对是否扣费。', 'NO_TASK_ID', null, true);
  return String(id);
}
async function query(base, key, id) {
  const response = await json(base + '/v2/query/video_generation/' + encodeURIComponent(id), key);
  const task = response.task || response;
  return {
    state: String(task.status || '').toLowerCase(),
    url: task.content?.url || task.content?.video_url || task.url,
    fileId: task.file_id || task.content?.file_id,
    code: task.error?.code ?? task.base_resp?.status_code ?? task.error_code,
  };
}
async function fileUrl(base, key, id) {
  const response = await json(base + '/v1/files/retrieve?file_id=' + encodeURIComponent(id), key);
  const url = response.file?.download_url || response.file?.url || response.download_url;
  if (!url) throw new ProviderError('MiniMax 未提供下载链接。', 'NO_URL');
  return url;
}
async function download(url, dest) {
  if (new URL(url).protocol !== 'https:') throw Error('成片下载地址必须使用 HTTPS。');
  const response = await fetch(url, { signal: AbortSignal.timeout(600000), redirect: 'error' });
  if (!response.ok || !response.body) throw new ProviderError('下载失败，请重试下载。', response.status);
  try {
    await pipeline(response.body, createWriteStream(dest + '.partial'));
    await fs.rename(dest + '.partial', dest);
  } finally { await fs.rm(dest + '.partial', { force: true }).catch(() => {}); }
}
async function testMiniMax(base, key) {
  await json(base + '/v2/query/video_generation?page_num=1&page_size=1', key);
  return 'MiniMax 查询鉴权通过。按量付费权限由生成接口确认。';
}
async function deepChat(key, model, messages) {
  const response = await json(DEEPSEEK + '/chat/completions', key, JSON.stringify({
    model, messages, temperature: 0.2, max_tokens: 1200,
    ...(model === 'deepseek-flash' ? { thinking: { type: 'disabled' } } : {}),
  }));
  const answer = response.choices?.[0]?.message?.content;
  if (!answer) throw Error('DeepSeek 未返回可用结果。');
  return answer;
}
async function testDeepSeek(key) {
  await json(DEEPSEEK + '/models', key);
  return 'DeepSeek 鉴权通过。可在优化提示词时验证所选模型。';
}
async function optimize(key, model, shot) {
  const source = [shot.camera, shot.visual, shot.prompt].filter(Boolean).join('；');
  const result = await deepChat(key, model, [
    { role: 'system', content: '只精简一镜的画面和运镜。保留原有人名和动作，禁止增加新人物、事件、台词或对白指令。只输出精简后的单行文字。' },
    { role: 'user', content: source },
  ]);
  return result.replace(/[\r\n]+/g, ' ').trim();
}

module.exports = { BASES, create, download, fileUrl, isAuth, isExpired, optimize, prepare, query, testDeepSeek, testMiniMax };

