'use strict';
/**
 * deepseek.js — DeepSeek 文字处理客户端。
 * 用途：把拼装好的分镜提示词压成适合 MiniMax H3 的精简版；台词逐字不动。
 * 失败时不改原提示词，由调用方原样保留并把错误写进任务记录。
 *
 * 接口：POST https://api.deepseek.com/chat/completions（OpenAI 兼容）
 * 测试连接：GET https://api.deepseek.com/models
 */
const BASE_URL = 'https://api.deepseek.com';
const CHAT_MODEL = 'deepseek-chat';

async function postJson(url, key, body, timeoutMs = 60000) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // 非 JSON 响应（如网关错误页），保留原文以便报错时展示
  }
  if (!res.ok) {
    const msg =
      (data && (data.error?.message || data.message)) || text.slice(0, 200) || `HTTP ${res.status}`;
    const err = new Error(`DeepSeek 请求失败（HTTP ${res.status}）：${msg}`);
    err.status = res.status;
    err.code = data?.error?.code || null;
    throw err;
  }
  return data;
}

/** 测试连接：Key 有效返回 ok；401/402 等直接报鉴权失败，不崩溃。 */
async function testConnection(key) {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true, message: 'DeepSeek 连接正常' };
    if (res.status === 401) return { ok: false, message: 'DeepSeek 鉴权失败（401）：Key 不正确或未开通' };
    if (res.status === 402) return { ok: false, message: 'DeepSeek 余额不足（402）：请先充值' };
    return { ok: false, message: `DeepSeek 连接异常（HTTP ${res.status}）` };
  } catch (e) {
    return { ok: false, message: `DeepSeek 连接失败：${e.message}` };
  }
}

/**
 * 优化提示词：把拼装稿压成 H3 精简版。
 * 约束写死在 system 提示词里：保留全部事实（人物、场景、道具、走位、光线），
 * 台词必须逐字保留、一个字不改；只删重复套话；输出只要优化后的提示词正文。
 * 失败时抛错，调用方保留原提示词。
 */
async function polishPrompt(key, assembledPrompt) {
  const data = await postJson(
    `${BASE_URL}/chat/completions`,
    key,
    {
      model: CHAT_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            '你是短剧视频提示词优化助手。把用户给的分镜提示词压成适合 MiniMax H3 的精简版：保留全部事实（人物、场景、道具、走位、光线、运镜），台词必须逐字保留、一个字不改；删掉重复套话和与画面无关的说明；输出只要优化后的提示词正文，不要加任何解释、前缀或代码块。',
        },
        { role: 'user', content: assembledPrompt },
      ],
    },
    90000,
  );
  const text = data?.choices?.[0]?.message?.content;
  if (!text || !text.trim()) throw new Error('DeepSeek 返回了空内容，提示词未改动');
  return text.trim();
}

module.exports = { testConnection, polishPrompt, BASE_URL, CHAT_MODEL };
