'use strict';
/**
 * server.js — 短剧视频生成（桌面版）本地服务。
 *
 * 用法：npm install && npm start，然后打开 http://127.0.0.1:3000
 * 只依赖 adm-zip（解包用），其余全用 Node 内置模块；Node >= 18。
 *
 * 数据流：画布「导出项目」ZIP → POST /api/import → project.json 校验归一化 →
 * 每段按绑定拼 H3 提示词（超 15 秒均衡拆子段）→ DeepSeek 优化提示词（可选）→
 * MiniMax H3（V2，参考图模式）异步生成 → 轮询 → 成片下载到 data/downloads/。
 *
 * API Key 只存在本机 data/settings.json，接口一律只返回末 4 位，日志里绝不打印。
 * 子段成片不自动拼整集，各子段单独播放/下载（有意保持的范围）。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { loadJson, saveJson, maskKey } = require('./lib/store');
const { importZip } = require('./lib/importer');
const prompts = require('./lib/prompts');
const minimax = require('./lib/minimax');
const deepseek = require('./lib/deepseek');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DOWNLOADS_DIR = path.join(DATA_DIR, 'downloads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const META_FILE = path.join(DATA_DIR, 'meta.json');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const OVERRIDES_FILE = path.join(DATA_DIR, 'overrides.json');

for (const d of [DATA_DIR, PROJECTS_DIR, UPLOADS_DIR, DOWNLOADS_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const DEFAULT_SETTINGS = {
  deepseekKey: '',
  minimaxKey: '',
  minimaxBaseUrl: minimax.DEFAULT_BASE_URL,
  model: minimax.DEFAULT_MODEL,
  resolution: '768P',
  ratio: 'adaptive',
  generateAudio: true,
};

function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...loadJson(SETTINGS_FILE, {}) };
}
function saveSettings(s) {
  saveJson(SETTINGS_FILE, s);
}
function maskedSettings() {
  const s = loadSettings();
  return {
    deepseekKeySet: Boolean(s.deepseekKey),
    deepseekKeyMasked: maskKey(s.deepseekKey),
    minimaxKeySet: Boolean(s.minimaxKey),
    minimaxKeyMasked: maskKey(s.minimaxKey),
    minimaxBaseUrl: s.minimaxBaseUrl,
    model: s.model,
    resolution: s.resolution,
    ratio: s.ratio,
    generateAudio: s.generateAudio,
  };
}
function loadMeta() {
  return loadJson(META_FILE, { activeProjectId: null });
}
function saveMeta(m) {
  saveJson(META_FILE, m);
}
function loadJobs() {
  return loadJson(JOBS_FILE, { jobs: [] }).jobs;
}
function saveJobs(jobs) {
  saveJson(JOBS_FILE, { jobs });
}
function loadOverrides() {
  return loadJson(OVERRIDES_FILE, {});
}
function saveOverrides(o) {
  saveJson(OVERRIDES_FILE, o);
}

/** 扫描 data/projects，返回项目摘要列表。 */
function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const p = loadJson(path.join(PROJECTS_DIR, d.name, 'project.normalized.json'), null);
      if (!p) return null;
      const shots = p.segments.reduce((n, s) => n + s.shots.length, 0);
      return {
        id: p.id,
        canvasName: p.canvasName,
        importedAt: p.importedAt,
        segments: p.segments.length,
        shots,
        imageCount: p.imageCount || 0,
        missingImages: p.missingImages || [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.importedAt || '').localeCompare(a.importedAt || ''));
}

function loadProject(id) {
  return loadJson(path.join(PROJECTS_DIR, id, 'project.normalized.json'), null);
}

function projectDir(id) {
  return path.join(PROJECTS_DIR, id);
}

/** 某段某子段的当前提示词：手动/DeepSeek 改写优先，否则拼装稿。 */
function resolvePartPrompt(project, segment, part) {
  const overrides = loadOverrides()[project.id] || {};
  const ov = overrides[`${segment.index}:${part.partIndex}`];
  if (ov && ov.prompt) return { prompt: ov.prompt, source: ov.source || 'manual', updatedAt: ov.updatedAt };
  return { prompt: prompts.buildPartPrompt(project, segment, part), source: 'assembled', updatedAt: null };
}

/** 项目详情：每段拆子段、每子段拼提示词、绑定 chips。 */
function projectDetail(project) {
  const overrides = loadOverrides()[project.id] || {};
  return {
    ...project,
    segments: project.segments.map((seg) => {
      const parts = prompts.segmentParts(project, seg);
      return {
        ...seg,
        totalSeconds: prompts.segmentTotalSeconds(seg),
        parts: parts.map((part) => {
          const resolved = resolvePartPrompt(project, seg, part);
          const bindings = prompts.partBindings(project, part);
          return {
            partIndex: part.partIndex,
            partsCount: part.partsCount,
            seconds: part.seconds,
            shotIndexes: part.shots.map((s) => s.shotIndex),
            prompt: resolved.prompt,
            promptSource: resolved.source,
            promptUpdatedAt: resolved.updatedAt,
            characters: bindings.characters.map((c) => ({ id: c.id, name: c.name, portrait: c.image })),
            assets: bindings.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, image: a.image })),
            gridImage: seg.gridImage,
          };
        }),
      };
    }),
  };
}

/** 读图片文件转 data URI（MiniMax 参考图用）。返回 { dataUri, bytes }。 */
function imageToDataUri(projectId, relPath) {
  const full = path.join(projectDir(projectId), relPath);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(projectDir(projectId)))) throw new Error('图片路径越界：' + relPath);
  const buf = fs.readFileSync(resolved);
  const ext = path.extname(relPath).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : ext === '.gif' ? 'image/gif' : 'image/jpeg';
  return { dataUri: `data:${mime};base64,${buf.toString('base64')}`, bytes: buf.length };
}

// ---------- HTTP helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  if (file.includes('..')) return sendJson(res, 400, { ok: false, error: '非法路径' });
  const full = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
    return sendJson(res, 404, { ok: false, error: '找不到页面：' + pathname });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

function serveProjectImage(req, res, projectId, rel) {
  const full = path.join(projectDir(projectId), rel);
  const resolved = path.resolve(full);
  if (!resolved.startsWith(path.resolve(projectDir(projectId)))) {
    return sendJson(res, 400, { ok: false, error: '非法路径' });
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return sendJson(res, 404, { ok: false, error: '图片不存在：' + rel });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(resolved).pipe(res);
}

// ---------- MiniMax 任务轮询 ----------
const POLL_INTERVAL_MS = 20000;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

async function pollJobs() {
  const jobs = loadJobs();
  let changed = false;
  for (const job of jobs) {
    if (job.status !== 'queued' && job.status !== 'running') continue;
    if (Date.now() - new Date(job.createdAt).getTime() > JOB_TIMEOUT_MS) {
      job.status = 'failed';
      job.error = '轮询超时（30 分钟未出片），请重试';
      job.updatedAt = new Date().toISOString();
      changed = true;
      continue;
    }
    try {
      const settings = loadSettings();
      const q = await minimax.queryTask({
        baseUrl: settings.minimaxBaseUrl,
        key: settings.minimaxKey,
        taskId: job.taskId,
      });
      if (q.status === 'succeeded') {
        let url = q.url;
        if (!url && q.fileId) {
          url = await minimax.retrieveFileUrl({
            baseUrl: settings.minimaxBaseUrl,
            key: settings.minimaxKey,
            fileId: q.fileId,
          });
        }
        if (!url) throw new Error('MiniMax 任务成功但未返回成片地址');
        const dest = path.join(DOWNLOADS_DIR, `${job.id}.mp4`);
        await minimax.downloadToFile(url, dest);
        job.status = 'done';
        job.videoFile = `${job.id}.mp4`;
        job.updatedAt = new Date().toISOString();
        changed = true;
      } else if (q.status === 'failed' || q.status === 'cancelled') {
        job.status = 'failed';
        job.error = q.error || `MiniMax 任务${q.status === 'cancelled' ? '已取消' : '失败'}`;
        job.updatedAt = new Date().toISOString();
        changed = true;
      } else if (q.status === 'running' && job.status !== 'running') {
        job.status = 'running';
        job.updatedAt = new Date().toISOString();
        changed = true;
      }
    } catch (e) {
      // 轮询单次失败不改任务状态，下轮继续；只记错误供排查
      job.lastPollError = e.message;
      job.updatedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveJobs(jobs);
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method;

    if (method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    }

    if (method === 'GET' && pathname === '/api/state') {
      const meta = loadMeta();
      const jobs = loadJobs();
      return sendJson(res, 200, {
        ok: true,
        settings: maskedSettings(),
        projects: listProjects(),
        activeProjectId: meta.activeProjectId,
        jobs: jobs.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')),
      });
    }

    if (method === 'GET' && pathname === '/api/settings') {
      return sendJson(res, 200, { ok: true, settings: maskedSettings() });
    }

    if (method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      const s = loadSettings();
      if (body.deepseekKey !== undefined) s.deepseekKey = String(body.deepseekKey || '');
      if (body.minimaxKey !== undefined) s.minimaxKey = String(body.minimaxKey || '');
      if (body.minimaxBaseUrl) s.minimaxBaseUrl = String(body.minimaxBaseUrl);
      if (body.model) s.model = String(body.model);
      if (body.resolution) s.resolution = String(body.resolution);
      if (body.ratio) s.ratio = String(body.ratio);
      if (body.generateAudio !== undefined) s.generateAudio = Boolean(body.generateAudio);
      saveSettings(s);
      return sendJson(res, 200, { ok: true, settings: maskedSettings() });
    }

    if (method === 'POST' && pathname === '/api/test-connections') {
      const s = loadSettings();
      const out = {};
      out.deepseek = s.deepseekKey
        ? await deepseek.testConnection(s.deepseekKey)
        : { ok: false, message: '未填写 DeepSeek Key' };
      out.minimax = s.minimaxKey
        ? await minimax.testConnection({ baseUrl: s.minimaxBaseUrl, key: s.minimaxKey })
        : { ok: false, message: '未填写 MiniMax Key' };
      return sendJson(res, 200, { ok: true, ...out });
    }

    if (method === 'POST' && pathname === '/api/import') {
      const filename = req.headers['x-filename'] || 'project.zip';
      const tmpPath = path.join(UPLOADS_DIR, `${crypto.randomUUID()}.zip`);
      const total = Number(req.headers['content-length'] || 0);
      if (total > 1024 * 1024 * 1024) return sendJson(res, 400, { ok: false, error: '文件过大（超过 1GB）' });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(tmpPath);
        req.pipe(ws);
        req.on('error', reject);
        ws.on('finish', resolve);
        ws.on('error', reject);
      });
      try {
        const project = importZip(tmpPath, PROJECTS_DIR);
        const meta = loadMeta();
        meta.activeProjectId = project.id;
        saveMeta(meta);
        return sendJson(res, 200, {
          ok: true,
          project: {
            id: project.id,
            canvasName: project.canvasName,
            segments: project.segments.length,
            shots: project.segments.reduce((n, s) => n + s.shots.length, 0),
            imageCount: project.imageCount,
            missingImages: project.missingImages,
          },
          filename: String(filename),
        });
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
    }

    if (method === 'GET' && pathname === '/api/project') {
      const id = url.searchParams.get('id') || loadMeta().activeProjectId;
      if (!id) return sendJson(res, 404, { ok: false, error: '还没有导入任何项目，先导入画布导出 ZIP 包' });
      const project = loadProject(id);
      if (!project) return sendJson(res, 404, { ok: false, error: '找不到项目：' + id });
      return sendJson(res, 200, { ok: true, project: projectDetail(project) });
    }

    const partMatch = pathname.match(/^\/api\/segments\/(\d+)\/parts\/(\d+)\/(optimize|prompt)$/);
    if (partMatch && (method === 'POST' || method === 'PUT')) {
      const segmentIndex = Number(partMatch[1]);
      const partIndex = Number(partMatch[2]);
      const action = partMatch[3];
      const meta = loadMeta();
      const project = loadProject(url.searchParams.get('projectId') || meta.activeProjectId || '');
      if (!project) return sendJson(res, 404, { ok: false, error: '还没有导入任何项目' });
      const segment = project.segments.find((s) => s.index === segmentIndex);
      if (!segment) return sendJson(res, 404, { ok: false, error: '找不到第 ' + segmentIndex + ' 段' });
      const parts = prompts.segmentParts(project, segment);
      const part = parts[partIndex];
      if (!part) return sendJson(res, 404, { ok: false, error: '找不到该子段' });
      const overrides = loadOverrides();
      overrides[project.id] = overrides[project.id] || {};
      const key = `${segmentIndex}:${partIndex}`;
      if (action === 'prompt' && method === 'PUT') {
        const body = await readJsonBody(req);
        const text = String(body.text || '').trim();
        if (!text) return sendJson(res, 400, { ok: false, error: '提示词不能为空' });
        overrides[project.id][key] = { prompt: text, source: 'manual', updatedAt: new Date().toISOString() };
        saveOverrides(overrides);
        return sendJson(res, 200, { ok: true, prompt: text, source: 'manual' });
      }
      // optimize：DeepSeek 优化
      const settings = loadSettings();
      if (!settings.deepseekKey) {
        return sendJson(res, 400, { ok: false, error: '请先在设置里填写 DeepSeek Key' });
      }
      const current = resolvePartPrompt(project, segment, part);
      try {
        const polished = await deepseek.polishPrompt(settings.deepseekKey, current.prompt);
        overrides[project.id][key] = { prompt: polished, source: 'deepseek', updatedAt: new Date().toISOString() };
        saveOverrides(overrides);
        return sendJson(res, 200, { ok: true, prompt: polished, source: 'deepseek' });
      } catch (e) {
        // DeepSeek 失败不改提示词，原样保留
        return sendJson(res, 200, { ok: false, error: e.message, prompt: current.prompt, source: current.source });
      }
    }

    if (method === 'POST' && pathname === '/api/jobs') {
      const body = await readJsonBody(req);
      const settings = loadSettings();
      if (!settings.minimaxKey) {
        return sendJson(res, 400, { ok: false, error: '请先在设置里填写 MiniMax Key，再点生成' });
      }
      const meta = loadMeta();
      const project = loadProject(body.projectId || meta.activeProjectId || '');
      if (!project) return sendJson(res, 404, { ok: false, error: '还没有导入任何项目' });
      const segment = project.segments.find((s) => s.index === Number(body.segmentIndex));
      if (!segment) return sendJson(res, 404, { ok: false, error: '找不到该段' });
      const parts = prompts.segmentParts(project, segment);
      const part = parts[Number(body.partIndex) || 0];
      if (!part) return sendJson(res, 404, { ok: false, error: '找不到该子段' });
      const resolved = resolvePartPrompt(project, segment, part);
      const bindings = prompts.partBindings(project, part);

      // 参考图：四宫格图优先，其次绑定人物定妆照，再次场景/道具设定图；最多 9 张。
      const refs = [];
      const pushRef = (relPath, label) => {
        if (!relPath || refs.length >= 9) return;
        try {
          const { dataUri, bytes } = imageToDataUri(project.id, relPath);
          refs.push({ dataUri, label, bytes });
        } catch {
          // 图片缺失就跳过，不拦生成；原因记进任务
        }
      };
      if (segment.gridImage) pushRef(segment.gridImage, '四宫格图');
      for (const c of bindings.characters) pushRef(c.portrait || c.image, `定妆照:${c.name}`);
      for (const a of bindings.assets) pushRef(a.image, `${a.kind}:${a.name}`);
      // 请求体 ≤ 64MB：超了就从后往前砍参考图（四宫格图永远保留）
      const estBodyBytes = () =>
        Buffer.byteLength(JSON.stringify(resolved.prompt), 'utf8') +
        refs.reduce((n, r) => n + r.dataUri.length, 0);
      while (refs.length > 1 && estBodyBytes() > 60 * 1024 * 1024) refs.pop();

      const duration = prompts.clampDuration(part.seconds);
      const job = {
        id: crypto.randomUUID(),
        projectId: project.id,
        canvasName: project.canvasName,
        segmentIndex: segment.index,
        partIndex: part.partIndex,
        partsCount: part.partsCount,
        shotIndexes: part.shots.map((s) => s.shotIndex),
        seconds: part.seconds,
        duration,
        prompt: resolved.prompt,
        promptSource: resolved.source,
        refCount: refs.length,
        refLabels: refs.map((r) => r.label),
        status: 'queued',
        taskId: null,
        error: null,
        videoFile: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      try {
        const { taskId } = await minimax.createTask({
          baseUrl: settings.minimaxBaseUrl,
          key: settings.minimaxKey,
          model: settings.model,
          resolution: settings.resolution,
          duration,
          ratio: settings.ratio,
          generateAudio: settings.generateAudio,
          prompt: resolved.prompt,
          images: refs.map((r) => ({ dataUri: r.dataUri, label: r.label })),
        });
        job.taskId = taskId;
      } catch (e) {
        // 提交失败（如鉴权 1004/401）记进任务，不崩溃
        job.status = 'failed';
        job.error = e.message;
        const jobs = loadJobs();
        jobs.push(job);
        saveJobs(jobs);
        return sendJson(res, 200, { ok: false, error: e.message, job });
      }
      const jobs = loadJobs();
      jobs.push(job);
      saveJobs(jobs);
      return sendJson(res, 200, { ok: true, job });
    }

    if (method === 'GET' && pathname === '/api/jobs') {
      const jobs = loadJobs()
        .slice()
        .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      return sendJson(res, 200, { ok: true, jobs });
    }

    const jobVideoMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/(video|download)$/);
    if (method === 'GET' && jobVideoMatch) {
      const job = loadJobs().find((j) => j.id === jobVideoMatch[1]);
      if (!job || !job.videoFile) return sendJson(res, 404, { ok: false, error: '成片还没生成好' });
      const full = path.join(DOWNLOADS_DIR, job.videoFile);
      if (!fs.existsSync(full)) return sendJson(res, 404, { ok: false, error: '成片文件不存在' });
      const stat = fs.statSync(full);
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': stat.size };
      if (jobVideoMatch[2] === 'download') {
        headers['Content-Disposition'] = `attachment; filename="seg${job.segmentIndex}-part${job.partIndex + 1}.mp4"`;
      }
      res.writeHead(200, headers);
      fs.createReadStream(full).pipe(res);
      return;
    }

    const jobCancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
    if (method === 'POST' && jobCancelMatch) {
      const jobs = loadJobs();
      const job = jobs.find((j) => j.id === jobCancelMatch[1]);
      if (!job) return sendJson(res, 404, { ok: false, error: '找不到任务' });
      if (job.status === 'queued' || job.status === 'running') {
        job.status = 'cancelled';
        job.error = '已取消轮询（MiniMax 端任务如已创建仍可能继续计费，请留意）';
        job.updatedAt = new Date().toISOString();
        saveJobs(jobs);
      }
      return sendJson(res, 200, { ok: true, job });
    }

    if (method === 'GET' && pathname.startsWith('/api/images/')) {
      const rest = pathname.slice('/api/images/'.length);
      const [projectId, ...relParts] = rest.split('/');
      return serveProjectImage(req, res, projectId, relParts.join('/'));
    }

    if (method === 'GET') return serveStatic(req, res, pathname);
    return sendJson(res, 404, { ok: false, error: '未知接口' });
  } catch (e) {
    // 任何未捕获错误都返回 JSON，不让服务崩溃
    console.error('[server]', e);
    return sendJson(res, 500, { ok: false, error: e.message || '服务器内部错误' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`短剧视频生成已启动：http://${HOST}:${PORT}`);
  console.log(`数据目录：${DATA_DIR}`);
});
setInterval(() => {
  pollJobs().catch((e) => console.error('[poll]', e));
}, POLL_INTERVAL_MS);
