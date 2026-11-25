'use strict';
const fs = require('node:fs');
const files = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const atomic = require('write-file-atomic');
const projectData = require('./project');
const defaultProvider = require('./providers');
const media = require('./render');

const defaults = {
  base: 'https://api.minimax.io', resolution: '768P', ratio: '9:16', generateAudio: false,
  concurrency: 2, transition: 'dissolve', effects: true, miniModel: 'MiniMax-H3', deepModel: 'deepseek-chat',
  miniModels: ['MiniMax-H3', 'MiniMax-H3-Max'], deepModels: ['deepseek-chat', 'deepseek-reasoner'],
};
const keyLabels = { mini: 'MiniMax', deep: 'DeepSeek' };
const activeStates = ['submitting', 'remote'];
const submissionSettings = ({ base, ratio, resolution, generateAudio, miniModel }) => ({ base, ratio, resolution, generateAudio, model: miniModel });
const selectedClip = job => job?.selectedVersion ? job.versions?.find(version => version.localId === job.selectedVersion) :
  job?.status === 'done' ? job : null;
const sampleJobId = partId => 'sample-' + partId;
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
      ratio: ['9:16', '16:9', '1:1', 'adaptive'], transition: ['dissolve', 'cut'],
      miniModel: current.miniModels || [], deepModel: current.deepModels || [] };
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
  async refreshModels(kind) {
    if (!Object.hasOwn(keyLabels, kind)) throw Error('未知服务商。');
    const key = this.requireKey(kind);
    const listFn = kind === 'mini' ? this.provider.listMiniMaxModels : this.provider.listDeepSeekModels;
    if (typeof listFn !== 'function') throw Error('当前版本不支持获取模型列表。');
    const current = this.settings();
    const list = kind === 'mini' ? await listFn(current.base, key) : await listFn(key);
    if (!list.length) throw Error('该账号下没有可用模型，请检查 Key 权限。');
    const field = kind === 'mini' ? 'miniModels' : 'deepModels';
    const modelField = kind === 'mini' ? 'miniModel' : 'deepModel';
    const previous = this.data;
    const settings = { ...current, [field]: list };
    if (!list.includes(settings[modelField])) settings[modelField] = list[0];
    this.data = { ...previous, settings };
    try { this.save(); } catch (error) { this.data = previous; throw error; }
    return { models: list, model: settings[modelField] };
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
        mix: this.exportSettings(project),
        jobs: Object.fromEntries(Object.entries(project.jobs).map(([id, job]) => [id, {
          ...job, usable: Boolean(selectedClip(job)),
        }])),
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
      const sameCanvas = entry => project.canvasId && entry.canvasId ? entry.canvasId === project.canvasId :
        entry.canvasName === project.canvasName;
      await files.rename(dir, path.join(this.projectsDir, project.id));
      moved = true;
      const oldProjects = this.data.projects;
      const previous = oldProjects.find(sameCanvas);
      project.revision = (previous ? previous.revision || 1 : 0) + 1;
      const reuse = previous ? await this.reuseClips(previous, project) : { reused: [], pending: [] };
      const currentProjects = this.data.projects;
      this.data.projects = [project, ...currentProjects];
      try { this.save(); } catch (error) { this.data.projects = currentProjects; throw error; }
      return { id: project.id, revision: project.revision, ...reuse };
    } catch (error) {
      await files.rm(moved ? path.join(this.projectsDir, project.id) : dir, { recursive: true, force: true }).catch(() => {});
      if (moved) await files.rm(path.join(this.downloads, project.id), { recursive: true, force: true }).catch(() => {});
      if (error.code === 'ENOSPC') throw Error('磁盘空间不足，请释放空间后重试。');
      if (/central directory|invalid.*zip/i.test(error.message)) throw Error('ZIP 文件损坏或不是标准 ZIP。');
      throw error;
    }
  }
  async fingerprint(project, job, hashes) {
    const digest = createHash('sha256');
    digest.update(JSON.stringify([submissionSettings(job.settings), job.duration, job.prompt]));
    for (const ref of job.refs) {
      const file = path.join(this.projectsDir, project.id, ref);
      if (!hashes.has(file)) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        hashes.set(file, hash.digest('hex'));
      }
      digest.update(hashes.get(file));
    }
    return digest.digest('hex');
  }
  async reuseClips(previous, project) {
    const result = { reused: [], pending: [] };
    const hashes = new Map();
    for (const segment of project.segments) {
      let parts;
      try { parts = projectData.plan(segment); }
      catch { result.pending.push('第 ' + segment.index + ' 段需检查'); continue; }
      for (const part of parts) {
        const job = selectedClip(previous.jobs[part.id]);
        let reusable = false;
        if (job?.file) {
          try {
            const candidate = this.makeJob(project, segment, part, this.settings());
            reusable = await this.fingerprint(previous, job, hashes) === await this.fingerprint(project, candidate, hashes);
            if (reusable) {
              const dest = path.join(this.downloads, project.id);
              await files.mkdir(dest, { recursive: true });
              const file = candidate.localId + '.mp4';
              await files.copyFile(path.join(this.downloads, previous.id, job.file), path.join(dest, file));
              project.jobs[part.id] = { ...candidate, file, status: 'done', reused: true, hasAudio: job.hasAudio };
            }
          } catch (error) {
            if (error.code === 'ENOSPC') throw error;
            reusable = false;
          }
        }
        (reusable ? result.reused : result.pending).push(part.id);
      }
    }
    return result;
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
  async cleanupOldVersions(id) {
    const project = this.project(id);
    const sameCanvas = entry => project.canvasId && entry.canvasId ? entry.canvasId === project.canvasId :
      entry.canvasName === project.canvasName;
    const old = this.data.projects.filter(entry => entry.id !== id && sameCanvas(entry));
    for (const entry of old) {
      if (this.busy(entry)) throw Error('旧版「' + entry.canvasName + '」仍在生成，请等队列完成再清理。');
    }
    if (!old.length) return { removed: 0 };
    const previous = this.data.projects;
    this.data.projects = previous.filter(entry => !old.includes(entry));
    try { this.save(); } catch (error) { this.data.projects = previous; throw error; }
    for (const entry of old) await this.clean(entry);
    return { removed: old.length };
  }
  async setMusic(id, input) {
    const project = this.project(id);
    if (this.rendering.has(id)) throw Error('正在拼接，请稍后更换配乐。');
    if (!input) {
      project.music = null;
      project.dirty = true;
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
    project.dirty = true;
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
  editShot(id, segmentIndex, shotIndex, input) {
    const project = this.project(id);
    if (this.rendering.has(id)) throw Error('整集正在拼接，请稍后编辑。');
    const segment = this.segment(project, segmentIndex);
    const shot = segment.shots.find(item => item.shotIndex === shotIndex);
    if (!shot) throw Error('分镜不存在。');
    const fields = ['framing', 'visual', 'prompt', 'camera', 'sfx'];
    const originals = Object.fromEntries(fields.map(key => [key, shot[key]]));
    const next = input === null ? shot.originalFields : Object.fromEntries(fields.map(key => {
      if (typeof input?.[key] !== 'string' || input[key].length > 4000) throw Error('分镜内容无效或超过 4000 字。');
      return [key, input[key]];
    }));
    if (!next) return;
    const old = { check: project.check, dirty: project.dirty, originalFields: shot.originalFields };
    const history = project.edits[segmentIndex];
    const lines = { ...this.editsFor(project, segmentIndex) };
    if (Object.hasOwn(lines, shotIndex)) {
      delete lines[shotIndex];
      (project.edits[segmentIndex] ||= []).push({ mode: 'manual', lines, at: Date.now() });
    }
    Object.assign(shot, next, { originalFields: input === null ? undefined : shot.originalFields || originals });
    project.dirty = true;
    project.check = projectData.inspect(project);
    try { this.save(); }
    catch (error) {
      Object.assign(shot, originals, { originalFields: old.originalFields });
      project.check = old.check;
      project.dirty = old.dirty;
      if (history?.at(-1)?.lines === lines) history.pop();
      throw error;
    }
  }
  refs(project, segment, part) {
    const { files } = projectData.referenceFiles(project, segment, part);
    if (!segment.gridImage || files.some(file => !projectData.safeImage(file) || !project.images[file]?.valid)) {
      throw Error('第 ' + segment.index + ' 段缺少可读参考图，请查看一致性检查。');
    }
    return files.map(file => path.join(this.projectsDir, project.id, file));
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
  validateSubmission(project, job) {
    if ([...job.prompt].length > 7000) throw Error('提示词超过 7000 字符。');
    let bytes = Buffer.byteLength(JSON.stringify(job.prompt)) + 2048;
    for (const ref of job.refs) {
      const size = fs.statSync(path.join(this.projectsDir, project.id, ref)).size;
      if (size > 30 * 1024 ** 2) throw Error('参考图超过 30 MB：' + ref);
      bytes += Math.ceil(size / 3) * 4;
    }
    if (bytes > 64 * 1024 ** 2) throw Error('参考图编码后超过 64 MB 请求体限制。');
  }
  preflight(id, n, partId, mode = partId ? 'redo' : 'normal') {
    const project = this.project(id);
    const settings = { ...this.settings(), ...(mode === 'sample' ? { resolution: '480P' } : {}) };
    const blockers = [];
    const ready = [];
    const reviews = project.check.issues.filter(issue => !n || issue.segment === n);
    if (!this.key('mini')) blockers.push('请在设置填写 MiniMax Key。');
    if (this.data.hold) blockers.push(this.data.hold);
    if (this.rendering.has(id)) blockers.push('整集正在拼接。');
    let reused = 0;
    let matched = false;
    for (const segment of n ? [this.segment(project, n)] : project.segments) {
      let parts;
      try { parts = projectData.plan(segment); }
      catch (error) { blockers.push(error.message); continue; }
      for (const part of parts) {
        if (partId && part.id !== partId) continue;
        matched = true;
        const old = project.jobs[mode === 'sample' ? sampleJobId(part.id) : part.id];
        if (old && mode === 'normal') {
          if (selectedClip(old)) reused++;
          else if (['failed', 'uncertain'].includes(old.status)) blockers.push('子段 ' + part.id + ' 请在队列处理。');
          continue;
        }
        if (old && mode === 'sample' && old.status !== 'done') {
          blockers.push('已有小样任务，请在队列查看或重试。');
          continue;
        }
        try {
          const job = this.makeJob(project, segment, part, settings);
          this.validateSubmission(project, job);
          const { files, dropped } = projectData.referenceFiles(project, segment, part);
          ready.push({ id: part.id, duration: part.duration, files, dropped });
        } catch (error) {
          blockers.push('子段 ' + part.id + ' · ' + compactError(error).message);
        }
      }
    }
    if (partId && !matched) blockers.push('找不到所选子段。');
    return { blockers, ready, reviews, reused, settings: submissionSettings(settings) };
  }
  queueSample(id, segmentIndex, partId) {
    this.requireKey('mini');
    const project = this.project(id);
    if (this.data.hold || this.rendering.has(id)) throw Error('请等队列恢复或拼接完成后再生成小样。');
    const segment = this.segment(project, segmentIndex);
    const part = projectData.plan(segment).find(item => item.id === partId);
    if (!part) throw Error('子段不存在。');
    const key = sampleJobId(partId);
    const old = project.jobs[key];
    if (old && (old.status !== 'done' || this.running.has(old.localId))) throw Error('请先处理已有小样任务。');
    const next = this.makeJob(project, segment, part, { ...this.settings(), resolution: '480P' });
    this.validateSubmission(project, next);
    project.jobs[key] = { ...next, id: key };
    try { this.save(); }
    catch (error) {
      if (old) project.jobs[key] = old;
      else delete project.jobs[key];
      throw error;
    }
    this.tick();
  }
  redo(id, partId) {
    this.requireKey('mini');
    const project = this.project(id);
    const old = project.jobs[partId];
    if (this.data.hold || this.rendering.has(id)) throw Error('请在队列恢复或拼接完成后重做。');
    if (!selectedClip(old) || old.status !== 'done' || this.running.has(old.localId)) throw Error('当前子段无法重做。');
    const { part, segment } = this.plans(project, old.segment).find(item => item.part.id === partId);
    const next = this.makeJob(project, segment, part, this.settings());
    this.validateSubmission(project, next);
    const { versions = [], selectedVersion, usable, ...previous } = old;
    project.jobs[partId] = { ...next, versions: [...versions, previous], selectedVersion: selectedVersion || old.localId };
    try { this.save(); } catch (error) { project.jobs[partId] = old; throw error; }
    this.tick();
  }
  selectClip(id, partId, versionId) {
    const project = this.project(id);
    const job = project.jobs[partId];
    if (!job || this.rendering.has(id)) throw Error('当前无法更换片段。');
    const chosen = job.localId === versionId ? job : job.versions?.find(version => version.localId === versionId);
    if (chosen?.status !== 'done' || !chosen.file) throw Error('该版本还不能使用。');
    const previous = job.selectedVersion;
    const { dirty } = project;
    job.selectedVersion = chosen === job ? null : chosen.localId;
    project.dirty = true;
    try { this.save(); } catch (error) { job.selectedVersion = previous; project.dirty = dirty; throw error; }
  }
  queue(id, n, partId) {
    this.requireKey('mini');
    if (this.data.hold) throw Error('队列已暂停，请在设置检查 Key 后点「恢复队列」。');
    const project = this.project(id);
    if (project.episode.status === 'rendering') throw Error('整集正在拼接。');
    const settings = this.settings();
    if (partId && !n) throw Error('请指定子段所在分段。');
    const all = this.plans(project, n).filter(({ part }) => !partId || part.id === partId);
    if (partId && !all.length) throw Error('子段不存在。');
    const drafts = all.filter(({ part }) => !project.jobs[part.id]).map(({ part, segment }) => this.makeJob(project, segment, part, settings));
    for (const job of drafts) this.validateSubmission(project, job);
    for (const job of drafts) project.jobs[job.id] = job;
    if (!n && !partId) {
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
      job.hasAudio = content.audio;
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
      if (this.data.hold || !this.key('mini')) return this.renderReady();
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
        if (all.every(({ part }) => selectedClip(project.jobs[part.id]))) {
          this.rendering.add(project.id);
          void this.render(project, all).catch(error => {
            const failure = compactError(error);
            project.episode = project.previousEpisode ? { ...project.previousEpisode, rebuildError: failure.message } :
              { status: 'error', ...failure };
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
    const clips = plans.map(({ part }) => ({
      ...part, job: selectedClip(project.jobs[part.id]),
      file: path.join(folder, selectedClip(project.jobs[part.id]).file),
    }));
    for (const clip of clips) {
      try { await files.access(clip.file); }
      catch {
        const job = clip.job;
        job.status = 'failed';
        job.resumeRemote = Boolean(job.remoteId);
        if (job !== project.jobs[clip.id]) project.jobs[clip.id].selectedVersion = null;
        job.error = { message: '本地视频缺失，请重新下载。' };
        throw Error('本地缺少子段 ' + clip.id + '，请单独重试该子段。');
      }
    }
    const music = project.music && path.join(this.projectsDir, project.id, project.music.file);
    const mix = this.exportSettings(project);
    const meta = await this.assembler({ ffmpeg: this.ffmpeg, output, clips,
      settings: { ...this.settings(), ...project.episodeSettings, transition: this.settings().transition, ...mix },
      music, onStage: stage => { project.episode.stage = stage; },
    });
    project.episode = { status: 'done', name: path.basename(output), ...meta, mix, music: project.music?.name || '',
      timeline: clips.map(clip => ({ id: clip.id, segment: clip.segment, seconds: clip.seconds,
        version: clip.job.localId, prompt: clip.job.prompt })) };
    delete project.previousEpisode;
    project.dirty = false;
    this.save();
  }
  reassemble(id) {
    const project = this.project(id);
    const plans = this.plans(project);
    if (this.rendering.has(id)) throw Error('整集正在拼接。');
    if (!plans.every(({ part }) => selectedClip(project.jobs[part.id]))) throw Error('还有子段未生成完成。');
    project.autoAssemble = true;
    if (project.episode.status === 'done') project.previousEpisode = project.episode;
    project.episode = { status: 'waiting' };
    this.save();
    this.tick();
  }
  exportSettings(project) {
    return { nativeAudio: true, subtitles: true, effects: this.settings().effects, musicVolume: 20, ...project.mix };
  }
  setMix(id, input) {
    const project = this.project(id);
    if (this.rendering.has(id)) throw Error('正在拼接，请稍后调整导出设置。');
    const previous = project.mix;
    const { dirty } = project;
    const mix = this.exportSettings(project);
    for (const key of ['nativeAudio', 'subtitles', 'effects']) if (typeof input[key] === 'boolean') mix[key] = input[key];
    if (Number.isFinite(input.musicVolume)) mix.musicVolume = Math.max(0, Math.min(100, input.musicVolume));
    project.mix = mix;
    project.dirty = true;
    try { this.save(); } catch (error) { project.mix = previous; project.dirty = dirty; throw error; }
  }
  pathFor(type, id, item) {
    const project = this.project(id);
    if (type === 'image' && projectData.safeImage(item) && project.images[item]?.valid) return path.join(this.projectsDir, id, item);
    if (type === 'episode' && project.episode.status === 'done') return path.join(this.downloads, id, project.episode.name);
    if (type === 'music' && project.music) return path.join(this.projectsDir, id, project.music.file);
    if (type === 'clip') {
      const [part, version] = item.split(':');
      const job = project.jobs[part];
      const clip = !version ? selectedClip(job) : job?.localId === version ? job : job?.versions?.find(entry => entry.localId === version);
      if (clip?.status === 'done' && clip.file) return path.join(this.downloads, id, clip.file);
    }
    throw Error('素材不存在。');
  }
}

module.exports = { Workspace, defaults };

