'use strict';
/**
* 端到端冒烟测试（不用真实 Key，不花钱、不出片）：
* 1. 起服务（测试端口 + 临时数据目录）
* 2. 导入按导出格式造的测试包 → 校验段/镜/图数
* 3. 校验提示词拼装：20 秒段均衡拆成 2 个 10 秒子段（1-2 镜/3-4 镜），含整体设定/格位对照/逐字台词/结尾状态
* 4. 填假 Key → 设置只露末 4 位；测试连接应正确报鉴权失败、不崩溃
* 5. DeepSeek 优化（假 Key）失败时提示词原样保留
* 6. 手动改提示词能保存并标记手动编辑
* 7. 没 Key 时生成明确拦截；有假 Key 时提交 MiniMax 应把官方鉴权错误（1004/401）记进任务，服务不崩溃
*
* 用法：npm test
*/
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn} = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'duanju-test-'));

let failures = 0;
function check(name, cond, extra = '') {
if (cond) {
console.log(` ✓ ${name}`);
} else {
failures += 1;
console.log(` ✗ ${name} ${extra}`);
}
}

async function waitForHealth(timeoutMs = 15000) {
const start = Date.now();
while (Date.now() - start < timeoutMs) {
try {
const res = await fetch(`${BASE}/api/health`);
if (res.ok) return true;
} catch {
// 未启动，继续等
}
await new Promise((r) => setTimeout(r, 300));
}
return false;
}

async function main() {
const server = spawn(process.execPath, ['server.js'], {
cwd: ROOT,
env: {...process.env, PORT: String(PORT), DATA_DIR},
stdio: 'pipe',
});
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
try {
console.log('1) 等待服务启动…');
check('服务启动并响应 /api/health', await waitForHealth());

console.log('2) 导入测试包…');
const zipPath = path.join(ROOT, 'test', 'test-package.zip');
const zipBuf = fs.readFileSync(zipPath);
let res = await fetch(`${BASE}/api/import`, {
method: 'POST',
headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': 'test-package.zip'},
body: zipBuf,
});
let data = await res.json();
check('导入成功', data.ok, JSON.stringify(data).slice(0, 200));
check('2 段 8 镜', data.project && data.project.segments === 2 && data.project.shots === 8, JSON.stringify(data.project));
check('6 张图打包', data.project && data.project.imageCount === 6, JSON.stringify(data.project));
check('缺图为空', data.project && (data.project.missingImages || []).length === 0);

console.log('3) 校验提示词拼装与均衡拆段…');
res = await fetch(`${BASE}/api/project`);
data = await res.json();
const seg1 = data.project.segments.find((s) => s.index === 1);
const seg2 = data.project.segments.find((s) => s.index === 2);
check('第 1 段拆成 2 个子段', seg1.parts.length === 2, `实际 ${seg1.parts.length}`);
check('子段 1：1-2 镜，10 秒', seg1.parts[0].seconds === 10 && seg1.parts[0].shotIndexes.join() === '1,2', JSON.stringify(seg1.parts[0]));
check('子段 2：3-4 镜，10 秒', seg1.parts[1].seconds === 10 && seg1.parts[1].shotIndexes.join() === '3,4', JSON.stringify(seg1.parts[1]));
check('第 2 段 12 秒不拆', seg2.parts.length === 1 && seg2.parts[0].seconds === 12);
const p1 = seg1.parts[0].prompt;
check('提示词含整体设定', p1.includes(''));
check('提示词含格位对照', p1.includes('') && p1.includes('左上→分镜1'));
check('提示词含本段设定与结尾状态', p1.includes('') && p1.includes(''));
check('子段 2 提示词含逐字台词', seg1.parts[1].prompt.includes('今天涩谷，人好多。'));
check('子段绑定人物正确', seg1.parts[0].characters.map((c) => c.name).join() === '小雅,阿杰');

console.log('4) 填假 Key，校验只露末 4 位与测试连接…');
res = await fetch(`${BASE}/api/settings`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ deepseekKey: 'test-deepseek-key-1234', minimaxKey: 'test-minimax-key-5678'}),
});
data = await res.json();
check('设置保存成功', data.ok);
check('DeepSeek 只露末 4 位', data.settings.deepseekKeyMasked === '****1234', data.settings.deepseekKeyMasked);
check('MiniMax 只露末 4 位', data.settings.minimaxKeyMasked === '****5678', data.settings.minimaxKeyMasked);
check('接口不返回完整 Key',!JSON.stringify(data).includes('test-deepseek-key-1234') &&!JSON.stringify(data).includes('test-minimax-key-5678'));
res = await fetch(`${BASE}/api/test-connections`, { method: 'POST'});
data = await res.json();
check('DeepSeek 假 Key 报鉴权失败', data.deepseek && data.deepseek.ok === false, JSON.stringify(data.deepseek));
check('MiniMax 假 Key 报鉴权失败', data.minimax && data.minimax.ok === false, JSON.stringify(data.minimax));

console.log('5) DeepSeek 优化（假 Key）失败时提示词原样保留…');
const before = seg1.parts[0].prompt;
res = await fetch(`${BASE}/api/segments/1/parts/0/optimize`, { method: 'POST'});
data = await res.json();
check('优化返回失败但不崩溃', data.ok === false && typeof data.error === 'string', JSON.stringify(data).slice(0, 200));
check('提示词未被改动', data.prompt === before);

console.log('6) 手动改提示词…');
res = await fetch(`${BASE}/api/segments/1/parts/0/prompt`, {
method: 'PUT',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ text: '手动测试提示词'}),
});
data = await res.json();
check('手动编辑保存成功', data.ok && data.source === 'manual');
res = await fetch(`${BASE}/api/project`);
data = await res.json();
check('读回为手动版', data.project.segments[0].parts[0].prompt === '手动测试提示词');
check('标记为手动编辑', data.project.segments[0].parts[0].promptSource === 'manual');

console.log('7) 没 Key 时生成明确拦截…');
await fetch(`${BASE}/api/settings`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ minimaxKey: ''}),
});
res = await fetch(`${BASE}/api/jobs`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ segmentIndex: 1, partIndex: 0}),
});
data = await res.json();
check('没 Key 返回 400 并明说原因', res.status === 400 && /MiniMax Key/.test(data.error || ''), `HTTP ${res.status} ${JSON.stringify(data)}`);

console.log('8) 有假 Key 时提交 MiniMax，鉴权错误应记进任务、服务不崩…');
await fetch(`${BASE}/api/settings`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ minimaxKey: 'test-minimax-key-5678'}),
});
res = await fetch(`${BASE}/api/jobs`, {
method: 'POST',
headers: { 'Content-Type': 'application/json'},
body: JSON.stringify({ segmentIndex: 2, partIndex: 0}),
});
data = await res.json();
check('提交返回任务记录', Boolean(data.job), JSON.stringify(data).slice(0, 300));
check('任务状态为失败', data.job && data.job.status === 'failed', JSON.stringify(data.job));
check('错误提到鉴权（1004/401）', data.job && /1004|401/.test(data.job.error || ''), data.job && data.job.error);
res = await fetch(`${BASE}/api/health`);
check('服务仍然健康', res.ok);
res = await fetch(`${BASE}/api/jobs`);
data = await res.json();
check('任务列表可读', data.ok && data.jobs.length >= 1);
} finally {
server.kill();
fs.rmSync(DATA_DIR, { recursive: true, force: true});
}
console.log(failures === 0? '\n全部通过 ✓': `\n${failures} 项失败 ✗`);
process.exit(failures === 0? 0: 1);
}

main().catch((e) => {
console.error('测试异常：', e);
process.exit(1);
});
