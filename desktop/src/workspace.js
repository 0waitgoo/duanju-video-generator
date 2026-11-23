'use strict';
const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const atomic = require('write-file-atomic');
const projectData = require('./project');
const defaultProvider = require('./providers');
const media = require('./render');

const defaults = {
  base: 'https://api.minimax.io', resolution: '768P', ratio: '9:16', generateAudio: false,
  concurrency: 2, transition: 'dissolve', effects: true, deepModel: 'deepseek-chat',
};
const keyLabels = { mini: 'MiniMax', deep: 'DeepSeek' };
const activeStates = ['submitting', 'remote'];
const compactError = error => {
  if (error.code === 'ENOSPC') return { message: '磁盘空间不足，请释放空间后重试。', code: 'ENOSPC' };
  return { message: error.message || '操作失败，请检查网络或本地文件。', code: error.code ?? error.status ?? '' };
};
class Workspace {
  constructor({ root, secureStorage, ffmpeg, provider = defaultProvider, assembler = media.assemble, pollMs = 12000 }) {
    Object.assign(this, { root, secureStorage, ffmpeg, provider, assembler, pollMs });
    this.projectsDir = path.join(root, 'projects');
    this.downloads = path.join(root, 'downloads');
    for (const dir of [root, this.projectsDir, this.downloads]) fs.mkdirSync(dir, { recursive: true });
    this.stateFile = path.join(root, 'workspace.json');
    this.data = this.load(this.stateFile, { projects: [], settings: defaults, secrets: {}, hold: null });
    this.running = new Set();
    this.rendering = new Set();
    this.lastQueueError = '';
    let recovered = false;
    for (const project of this.data.projects) {
      this.initialize(project);
      for (const job of Object.values(project.jobs)) {
        if (job.status === 'submitting') {
          job.status = 'uncertain';
          job.error = { message: '上次关闭时未收到任务编号。请先在 MiniMax 核对任务，再恢复查询或重新提交。', code: 'UNKNOWN_SUBMISSION' };
          recovered = true;
        }
      }
      if (project.episode.status === 'rendering') {
        project.episode.status = 'waiting';
        recovered = true;
      }
    }
    if (recovered) this.save();
  }
  load(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw Error('本机工作区数据无法读取，请保留原文件并检查磁盘。');
    }
  }
  save() { atomic.sync(this.stateFile, JSON.stringify(this.data, null, 2)); }
  initialize(project) {
    project.jobs ||= {};
    project.edits ||= {};
    project.episode ||= { status: 'idle' };
    project.autoAssemble ||= false;
  }
  start() {
    if (!this.timer) this.timer = setInterval(() => this.tick(), 800);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
  key(kind) {
    const value = this.data.secrets[kind];
    if (!value) return '';
    try { return this.secureStorage.decryptString(Buffer.from(value, 'base64')); }
    catch { return ''; }
  }
  requireKey(kind) {
    if (!Object.hasOwn(keyLabels, kind)) throw Error('未知服务商。');
    const key = this.key(kind);
    if (!key) throw Error('缺少 ' + keyLabels[kind] + ' Key，请在设置中填写。');
    return key;
  }
  settings() { return { ...defaults, ...this.data.settings }; }
  setSettings(input) {
    const current = this.settings();
    const choices = { base: defaultProvider.BASES, resolution: ['768P', '2K'],
      ratio: ['9:16', '16:9', '1:1', 'adaptive'], transition: ['dissolve', 'cut'], deepModel: ['deepseek-chat', 'deepseek-flash'] };
    for (const [field, allowed] of Object.entries(choices)) {
      if (allowed.includes(input[field])) current[field] = input[field];
    }
    for (const field of ['generateAudio', 'effects']) {
      if (typeof input[field] === 'boolean') current[field] = input[field];
    }
    if (Number.isInteger(input.concurrency)) current.concurrency = Math.max(1, Math.min(6, input.concurrency));
    const secrets = { ...this.data.secrets };
    for (const kind of Object.keys(keyLabels)) {
      if (input[kind + 'Clear'] === true) delete secrets[kind];
      const value = typeof input[kind] === 'string' ? input[kind].trim() : '';
      if (!value) continue;
      if (value.length > 8192 || /[\r\n]/.test(value)) throw Error(keyLabels[kind] + ' Key 格式不正确。');
      if (!this.secureStorage.isEncryptionAvailable()) throw Error('Windows 密钥加密不可用，请检查当前账户。');
      secrets[kind] = this.secureStorage.encryptString(value).toString('base64');
    }
    const previous = this.data;
    this.data = { ...previous, settings: current, secrets };
    try { this.save(); } catch (error) { this.data = previous; throw error; }
    return this.snapshot().settings;
  }
  async testConnection(kind) {
    const key = this.requireKey(kind);
    return kind === 'mini' ? this.provider.testMiniMax(this.settings().base, key) : this.provider.testDeepSeek(key);
  }
  project(id) {
    const project = this.data.projects.find(entry => entry.id === id);
    if (!project) throw Error('项目已不存在。');
    return project;
  }
  snapshot() {
    return {
      projects: this.data.projects.map(({ images, music, ...project }) => ({
        ...project,
        jobs: Object.fromEntries(Object.entries(project.jobs).map(([id, { file, ...job }]) => [id, job])),
        images: Object.fromEntries(Object.entries(images).map(([name, size]) => [name, size.valid])),
        music: music?.name || '',
        segments: project.segments.map(segment => {
          let parts = [];
          let problem = '';
          try {
            parts = projectData.plan(segment).map(part => ({
              ...part, prompt: projectData.prompt(project, segment, part, this.editsFor(project, segment.index)),
            }));
          } catch (error) { problem = error.message; }
          return { ...segment, parts, problem,
            bindings: projectData.bindings(project, segment.shots),
            shots: segment.shots.map(shot => ({ ...shot, bindings: projectData.bindings(project, [shot]) })),
          };
        }),
      })),
      settings: {
        ...this.settings(), miniSuffix: this.key('mini').slice(-4), deepSuffix: this.key('deep').slice(-4),
      },
      hold: this.data.hold, queueError: this.lastQueueError,
    };
  }
  async import(file) {
    const dir = await files.mkdtemp(path.join(this.projectsDir, '.import-'));
    let project;
    let moved = false;
    try {
      project = await projectData.readProjectZip(file, dir);
      this.initialize(project);
      const sameCanvas = entry =>
        (project.canvasId && entry.canvasId === project.canvasId) || entry.canvasName === project.canvasName;
      await files.rename(dir, path.join(this.projectsDir, project.id));
      moved = true;
      const oldProjects = this.data.projects;
      const previous = oldProjects.find(sameCanvas);
      if (previous && this.busy(previous)) throw Error('同名项目仍在生成，请等队列完成再替换。');
      this.data.projects = [project, ...this.data.projects.filter(entry => entry !== previous)];
      try { this.save(); } catch (error) { this.data.projects = oldProjects; throw error; }
      if (previous) void this.clean(previous);
      return { id: project.id, replaced: Boolean(previous) };
    } catch (error) {
      await files.rm(moved ? path.join(this.projectsDir, project.id) : dir, { recursive: true, force: true }).catch(() => {});
      if (error.code === 'ENOSPC') throw Error('磁盘空间不足，请释放空间后重试。');
      if (/central directory|invalid.*zip/i.test(error.message)) throw Error('ZIP 文件损坏或不是标准 ZIP。');
      throw error;
    }
  }
  busy(project) {
    return this.rendering.has(project.id) ||
      Object.values(project.jobs).some(job => this.running.has(job.localId) || activeStates.includes(job.status) || job.status === 'queued');
  }
  async clean(project) {
    await Promise.allSettled([
      files.rm(path.join(this.projectsDir, project.id), { recursive: true, force: true }),
      files.rm(path.join(this.downloads, project.id), { recursive: true, force: true }),
    ]);
  }
  async remove(id) {
    const project = this.project(id);
    if (this.busy(project)) throw Error('请等该项目的队列完成再删除。');
    const previous = this.data.projects;
    this.data.projects = previous.filter(entry => entry.id !== id);
    try { this.save(); } catch (error) { this.data.projects = previous; throw error; }
    await this.clean(project);
  }
  async setMusic(id, input) {
    const project = this.project(id);
    if (this.rendering.has(id)) throw Error('正在拼接，请稍后更换配乐。');
    if (!input) {
      project.music = null;
      this.save();
      return;
    }
    const extension = path.extname(input).toLowerCase();
    if (!['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg'].includes(extension)) throw Error('配乐格式不支持。');
    const info = await media.probe(this.ffmpeg, input, this.root);
    if (!info.audio || !info.duration) throw Error('配乐文件无法读取。');
    const file = 'music-' + randomUUID() + extension;
    const dir = path.join(this.projectsDir, id);
    await files.copyFile(input, path.join(dir, file));
    const previous = project.music;
    project.music = { file, name: path.basename(input) };
    try { this.save(); } catch (error) { project.music = previous; throw error; }
    if (previous) await files.rm(path.join(dir, previous.file), { force: true }).catch(() => {});
  }
  segment(project, n) {
    const segment = project.segments.find(item => item.index === n);
    if (!segment) throw Error('段不存在。');
    return segment;
  }
  editsFor(project, n) { return project.edits[n]?.at(-1)?.lines || {}; }
  async edit(id, n, lines, mode) {
    const project = this.project(id);
    const segment = this.segment(project, n);
    const existing = this.editsFor(project, n);
    const active = projectData.bindings(project, segment.shots).characters;
    const inactive = project.characters.filter(item => !active.includes(item));
    const changes = {};
    const key = mode === 'deep' ? this.requireKey('deep') : '';
    for (const shot of segment.shots) {
      const input = mode === 'deep' ? await this.provider.optimize(key, this.settings().deepModel, shot) : lines?.[shot.shotIndex];
      if (input === undefined || input === '') continue;
      if (typeof input !== 'string' || input.length > 4000 || /[\r\n]|台词|对白|说[道：:]|对话|开口|说道|[「」“”]/.test(input) ||
        inactive.some(item => input.includes(item.name))) throw Error('第 ' + shot.shotIndex + ' 镜的编辑含台词指令或未绑定人物，已保留原提示词。');
      changes[shot.shotIndex] = input;
    }
    if (this.project(id) !== project || this.editsFor(project, n) !== existing && project.edits[n]?.length) {
      throw Error('提示词版本已变化，请重新打开工作台。');
    }
    (project.edits[n] ||= []).push({ mode, lines: changes, at: Date.now() });
    this.save();
  }
  undo(id, n) {
    const project = this.project(id);
    project.edits[n]?.pop();
    this.save();
  }
  refs(project, segment, part) {
    const binding = projectData.bindings(project, part.shots);
    const refs = [...new Set([segment.gridImage, ...Object.values(binding).flat().map(item => item.image)])];
    if (refs.some(file => !projectData.safeImage(file) || !project.images[file]?.valid)) {
      throw Error('第 ' + segment.index + ' 段缺少可读参考图，请查看一致性检查。');
    }
    if (refs.length > 9) throw Error('第 ' + segment.index + ' 段的子段参考图超过 9 张，请在画布减少绑定。');
    return refs.map(file => path.join(this.projectsDir, project.id, file));
  }
  plans(project, n) {
    return (n ? [this.segment(project, n)] : project.segments).flatMap(segment =>
      projectData.plan(segment).map(part => ({ part, segment })));
  }
  makeJob(project, segment, part, settings) {
    return {
      localId: randomUUID(), id: part.id, segment: segment.index, shots: part.shots.map(shot => shot.shotIndex),
      duration: part.duration, settings, status: 'queued', remoteId: '', nextAt: 0, attempts: [],
      refs: this.refs(project, segment, part).map(file => path.relative(path.join(this.projectsDir, project.id), file)),
      prompt: projectData.prompt(project, segment, part, this.editsFor(project, segment.index)), created: Date.now(),
    };
  }
  queue(id, n) {
    this.requireKey('mini');
    this.requireKey('deep');
    if (this.data.hold) throw Error('队列已暂停，请在设置检查 Key 后点「恢复队列」。');
    const project = this.project(id);
    if (project.episode.status === 'rendering') throw Error('整集正在拼接。');
    const settings = this.settings();
    const all = this.plans(project, n);
    const drafts = all.filter(({ part }) => !project.jobs[part.id]).map(({ part, segment }) => this.makeJob(project, segment, part, settings));
    for (const job of drafts) project.jobs[job.id] = job;
    if (!n) {
      project.autoAssemble = true;
      project.episodeSettings ||= settings;
      if (project.episode.status !== 'done') project.episode = { status: 'waiting' };
    }
    this.save();
    this.tick();
    return drafts.length;
  }
  retry(id, jobId, remoteId) {
    this.requireKey('mini');
    this.requireKey('deep');
    if (this.data.hold) throw Error('队列已暂停，请先在设置恢复。');
    const project = this.project(id);
    const job = project.jobs[jobId];
    if (!job || !['failed', 'uncertain'].includes(job.status) || this.running.has(job.localId)) throw Error('这个子段当前不能重试。');
    if (remoteId && (!/^[a-zA-Z0-9_-]{1,128}$/.test(remoteId) || job.status !== 'uncertain')) throw Error('任务编号格式不正确。');
    if (remoteId) job.remoteId = remoteId;
    else if (!job.resumeRemote) {
      job.remoteId = '';
      job.settings = { ...job.settings, base: this.settings().base };
    }
    job.status = job.remoteId ? 'remote' : 'queued';
    job.error = null;
    job.nextAt = 0;
    job.networkFailures = 0;
    if (project.autoAssemble && project.episode.status === 'error') project.episode = { status: 'waiting' };
    this.save();
    this.tick();
  }
  resume() {
    this.requireKey('mini');
    this.requireKey('deep');
    this.data.hold = null;
    for (const project of this.data.projects) {
      for (const job of Object.values(project.jobs)) {
        if (job.error?.auth && job.status === 'failed') {
          job.status = job.remoteId ? 'remote' : 'queued';
          if (!job.remoteId) job.settings = { ...job.settings, base: this.settings().base };
          job.error = null;
          job.nextAt = 0;
        }
      }
    }
    this.save();
    this.tick();
  }
  async step(project, job) {
    const key = this.requireKey('mini');
    if (job.status === 'queued') {
      const refs = job.refs.map(file => path.join(this.projectsDir, project.id, file));
      const body = await this.provider.prepare(job.settings, job.prompt, refs, job.duration);
      if (this.data.hold) return;
      job.status = 'submitting';
      job.attempts.push({ at: Date.now(), duration: job.duration, resolution: job.settings.resolution });
      this.save();
      job.remoteId = await this.provider.create(job.settings, key, body);
      job.status = 'remote';
      job.nextAt = Date.now() + this.pollMs;
      this.save();
      return;
    }
    const result = await this.provider.query(job.settings.base, key, job.remoteId);
    job.networkFailures = 0;
    if (['queued', 'running', 'processing', 'pending'].includes(result.state)) {
      job.nextAt = Date.now() + this.pollMs;
      job.error = null;
    } else if (['succeeded', 'success', 'completed'].includes(result.state)) {
      const folder = path.join(this.downloads, project.id);
      await files.mkdir(folder, { recursive: true });
      const name = /^[a-zA-Z0-9_-]{1,100}$/.test(job.remoteId) ? job.remoteId : job.localId;
      const file = path.join(folder, name + '.mp4');
      const exists = await files.stat(file).then(stat => stat.size > 0).catch(() => false);
      if (!exists) {
        const url = result.url || (result.fileId && await this.provider.fileUrl(job.settings.base, key, result.fileId));
        if (!url) throw Error('任务完成，但 MiniMax 未返回下载地址。');
        await this.provider.download(url, file);
      }
      const content = await media.probe(this.ffmpeg, file, folder);
      if (!content.width || !content.duration) {
        await files.rm(file, { force: true });
        throw Error('下载的视频无法读取，可重新下载。');
      }
      job.file = name + '.mp4';
      job.status = 'done';
      job.error = null;
    } else {
      job.status = 'failed';
      job.resumeRemote = false;
      job.error = { message: result.state === 'cancelled' ? 'MiniMax 已取消该任务。' : 'MiniMax 生成失败或返回未知状态。', code: result.code || result.state || 'UNKNOWN' };
    }
    this.save();
  }
  handleError(job, error) {
    const failedDuringSubmit = job.status === 'submitting';
    const auth = this.provider.isAuth(error);
    const expired = this.provider.isExpired(error);
    job.error = { ...compactError(error), auth };
    if (auth) this.data.hold = 'MiniMax 鉴权失败（1004/401），已暂停全部任务。请检查按量付费 Key 和任务所属站点。';
    if (failedDuringSubmit && (error.ambiguous || job.remoteId)) {
      job.status = 'uncertain';
      job.error.message = '提交结果待核对。请先检查 MiniMax 任务记录，避免重复扣费。';
    } else if (job.remoteId && error.code === 'NETWORK' && (job.networkFailures || 0) < 5) {
      job.networkFailures = (job.networkFailures || 0) + 1;
      job.nextAt = Date.now() + Math.min(120000, this.pollMs * 2 ** job.networkFailures);
    } else {
      job.status = 'failed';
      job.resumeRemote = Boolean(job.remoteId) && !expired;
    }
    this.save();
  }
  tick() {
    const now = Date.now();
    try {
      if (this.data.hold || !this.key('mini') || !this.key('deep')) return this.renderReady();
      const pending = this.data.projects.flatMap(project => Object.values(project.jobs).map(job => ({ project, job })));
      const limit = this.settings().concurrency;
      let occupied = pending.filter(({ job }) => activeStates.includes(job.status) || this.running.has(job.localId)).length;
      for (const { project, job } of pending) {
        if (this.running.has(job.localId)) continue;
        if (job.status === 'remote' && job.nextAt <= now) this.launch(project, job);
        if (job.status === 'queued' && occupied < limit) {
          occupied++;
          this.launch(project, job);
        }
      }
      this.renderReady();
    } catch (error) { this.lastQueueError = compactError(error).message; }
  }
  launch(project, job) {
    this.running.add(job.localId);
    void this.step(project, job).catch(error => this.handleError(job, error)).catch(error => {
      this.lastQueueError = compactError(error).message;
    }).finally(() => this.running.delete(job.localId));
  }
  renderReady() {
    for (const project of this.data.projects) {
      if (project.autoAssemble && project.episode.status === 'waiting' && !this.rendering.size) {
        let all;
        try { all = this.plans(project); } catch { continue; }
        if (all.every(({ part }) => project.jobs[part.id]?.status === 'done')) {
          this.rendering.add(project.id);
          void this.render(project, all).catch(error => {
            project.episode = { status: 'error', ...compactError(error) };
            try { this.save(); } catch (saveError) { this.lastQueueError = compactError(saveError).message; }
          }).finally(() => this.rendering.delete(project.id));
        }
      }
    }
  }
  async render(project, plans) {
    project.episode = { status: 'rendering', stage: '正在准备素材' };
    this.save();
    const folder = path.join(this.downloads, project.id);
    const output = path.join(folder, 'episode-' + randomUUID() + '.mp4');
    const clips = plans.map(({ part }) => ({ ...part, file: path.join(folder, project.jobs[part.id].file) }));
    for (const clip of clips) {
      try { await files.access(clip.file); }
      catch {
        const job = project.jobs[clip.id];
        job.status = 'failed';
        job.resumeRemote = true;
        job.error = { message: '本地视频缺失，请重新下载。' };
        throw Error('本地缺少子段 ' + clip.id + '，请单独重试该子段。');
      }
    }
    const music = project.music && path.join(this.projectsDir, project.id, project.music.file);
    const meta = await this.assembler({ ffmpeg: this.ffmpeg, output, clips,
      settings: { ...this.settings(), ...project.episodeSettings, transition: this.settings().transition, effects: this.settings().effects },
      music, onStage: stage => { project.episode.stage = stage; },
    });
    project.episode = { status: 'done', name: path.basename(output), ...meta };
    this.save();
  }
  reassemble(id) {
    const project = this.project(id);
    const plans = this.plans(project);
    if (this.rendering.has(id)) throw Error('整集正在拼接。');
    if (!plans.every(({ part }) => project.jobs[part.id]?.status === 'done')) throw Error('还有子段未生成完成。');
    project.autoAssemble = true;
    project.episode = { status: 'waiting' };
    this.save();
    this.tick();
  }
  pathFor(type, id, item) {
    const project = this.project(id);
    if (type === 'image' && projectData.safeImage(item) && project.images[item]?.valid) return path.join(this.projectsDir, id, item);
    if (type === 'episode' && project.episode.status === 'done') return path.join(this.downloads, id, project.episode.name);
    if (type === 'clip' && Object.hasOwn(project.jobs, item) && project.jobs[item].status === 'done') return path.join(this.downloads, id, project.jobs[item].file);
    throw Error('素材不存在。');
  }
}

module.exports = { Workspace, defaults };

