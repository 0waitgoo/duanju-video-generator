'use strict';
/**
 * minimax.js — MiniMax H3 视频生成客户端（V2 接口，官方文档 platform.minimax.io）。
 *
 * 创建任务：POST {baseUrl}/v2/video_generation
 *   body: { model, content: [{type:'text', text}, {type:'image_url', image_url, role:'reference_image'}...],
 *           resolution, duration, ratio, generate_audio }
 * 查询任务：GET {baseUrl}/v2/query/video_generation/{task_id}
 *   status: queued / running / succeeded / failed / cancelled；成功时 task.content.url 即成片地址。
 *
 * 关键约束（官方文档）：
 * - 首帧（first_frame）和参考图（reference_image）互斥，不能混用。
 *   本项目按画布口径走参考图模式：四宫格图＋定妆照＋设定图全部以 reference_image 提交，
 *   不用 first_frame。
 * - 参考图 ≤ 9 张，单张 ≤ 30MB，请求体总计 ≤ 64MB；图片可用 Base64 data URI。
 * - MiniMax-H3：768P / 2K，时长 4–15 秒；H3 须用按量付费（Pay-as-you-go）API。
 * - 官方错误用 base_resp.status_code 表示：1004 = 鉴权失败；2013 = 任务不存在。
 * - Key 与地区绑定：国际站默认 https://api.minimax.io，中国大陆站可用 https://api.minimax.cn。
 *
 * 兼容处理：创建/查询响应同时接受 {"task": {...}} 与扁平两种形状；
 * 成功时优先取 task.content.url，若只有 file_id 则走 GET /v1/files/retrieve 换下载地址。
 */
const DEFAULT_BASE_URL = 'https://api.minimax.io';
const DEFAULT_MODEL = 'MiniMax-H3';

function readError(res, data, text) {
  const base = data?.base_resp || {};
  const code = base.status_code ?? data?.code ?? null;
  const msg = base.status_msg || data?.message || data?.error?.message || text.slice(0, 200);
  return { code, msg: msg || `HTTP ${res.status}` };
}

async function requestJson(url, { method = 'GET', key, body, timeoutMs = 60000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON 响应（如 404 页面），保留原文
  }
  if (!res.ok) {
    const { code, msg } = readError(res, data, text);
    const err = new Error(`MiniMax 请求失败（HTTP ${res.status}${code ? ` / code ${code}` : ''}）：${msg}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  // MiniMax 有时用 HTTP 200 + base_resp.status_code 报业务错（如 1004 鉴权失败、2013 任务不存在）
  const baseCode = data?.base_resp?.status_code;
  if (baseCode !== undefined && baseCode !== 0 && baseCode !== null) {
    const err = new Error(
      `MiniMax 请求失败（code ${baseCode}）：${data.base_resp.status_msg || '未知错误'}`,
    );
    err.status = res.status;
    err.code = baseCode;
    throw err;
  }
  return data;
}

/** 从创建/查询响应里取 task 对象（兼容 task 嵌套与扁平两种形状）。 */
function pickTask(data) {
  if (!data) return null;
  if (data.task && typeof data.task === 'object') return data.task;
  if (data.id || data.status) return data;
  return null;
}

/**
 * 创建视频生成任务（参考图模式）。
 * images: [{ dataUri, label }]，全部以 reference_image 提交；最多 9 张。
 * 返回 { taskId }。
 */
async function createTask({ baseUrl, key, model, resolution, duration, ratio, generateAudio, prompt, images }) {
  const refs = (images || []).slice(0, 9);
  const content = [{ type: 'text', text: prompt }];
  for (const img of refs) {
    content.push({ type: 'image_url', image_url: img.dataUri, role: 'reference_image' });
  }
  const data = await requestJson(`${baseUrl.replace(/\/$/, '')}/v2/video_generation`, {
    method: 'POST',
    key,
    body: {
      model: model || DEFAULT_MODEL,
      content,
      resolution: resolution || '768P',
      duration,
      ratio: ratio || 'adaptive',
      generate_audio: generateAudio !== false,
    },
    timeoutMs: 60000,
  });
  const task = pickTask(data);
  const taskId = data?.task_id || task?.id;
  if (!taskId) throw new Error('MiniMax 创建任务未返回 task_id：' + JSON.stringify(data).slice(0, 300));
  return { taskId };
}

/** 查询任务状态。返回 { status, url, error, raw }。 */
async function queryTask({ baseUrl, key, taskId }) {
  const data = await requestJson(
    `${baseUrl.replace(/\/$/, '')}/v2/query/video_generation/${encodeURIComponent(taskId)}`,
    { key, timeoutMs: 30000 },
  );
  const task = pickTask(data) || {};
  const status = task.status || 'unknown';
  let url = task.content?.url || task.content?.video_url || task.url || null;
  let error = null;
  if (status === 'failed') {
    error = task.error?.message || task.base_resp?.status_msg || task.fail_reason || 'MiniMax 任务失败';
  }
  return { status, url, error, fileId: task.file_id || task.content?.file_id || null, raw: task };
}

/** file_id 换下载地址（老版 v1 查询只给 file_id 时用）。 */
async function retrieveFileUrl({ baseUrl, key, fileId }) {
  const data = await requestJson(
    `${baseUrl.replace(/\/$/, '')}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`,
    { key, timeoutMs: 30000 },
  );
  const file = data?.file || data;
  const url = file?.download_url || file?.url;
  if (!url) throw new Error('MiniMax 换取下载地址失败：' + JSON.stringify(data).slice(0, 300));
  return url;
}

/**
 * 测试连接：用一个不存在的 task_id 查一次。
 * Key 错 → 401 / code 1004（鉴权失败）；Key 对 → 任务不存在（2013 / 404），说明鉴权通过。
 * 这样不花钱、不建任务就能区分。
 */
async function testConnection({ baseUrl, key }) {
  try {
    await queryTask({ baseUrl, key, taskId: 'test-connection-probe' });
    return { ok: true, message: 'MiniMax 连接正常' };
  } catch (e) {
    if (e.status === 401 || e.code === 1004 || e.code === 2049) {
      return { ok: false, message: 'MiniMax 鉴权失败（1004/401）：Key 不正确或不是按量付费 Key' };
    }
    if (e.code === 2013 || e.status === 404) {
      return { ok: true, message: 'MiniMax 连接正常（Key 有效，探测任务不存在是预期结果）' };
    }
    return { ok: false, message: `MiniMax 连接异常：${e.message}` };
  }
}

/** 下载成片到本地文件。 */
async function downloadToFile(url, destPath) {
  const fs = require('node:fs');
  const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!res.ok || !res.body) throw new Error(`下载成片失败（HTTP ${res.status}）`);
  const file = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.body.pipe(file);
    res.body.on('error', reject);
    file.on('finish', resolve);
    file.on('error', reject);
  });
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  createTask,
  queryTask,
  retrieveFileUrl,
  testConnection,
  downloadToFile,
};
