'use strict';
const { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage, shell } = require('electron');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable } = require('node:stream');
const path = require('node:path');
const { Workspace } = require('./workspace');
const { upscaleVideo } = require('./render');
const { seedRuntime, upscaleSeedVR2 } = require('./seedvr2');
const { imageType } = require('./project');

protocol.registerSchemesAsPrivileged([{ scheme: 'studio', privileges: {
  standard: true, secure: true, supportFetchAPI: true, stream: true,
} }]);
app.setName('短剧成片工作室');

let window;
let workspace;
let hdExporting = false;
async function runHD(method, file, output) {
  const sendProgress = progress => {
    if (window && !window.isDestroyed()) window.webContents.send('hd-progress', progress);
  };
  if (method === 'seedvr2') {
    const runtime = await seedRuntime(path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'DuanjuStudio', 'SeedVR2'));
    return upscaleSeedVR2(workspace.ffmpeg, runtime, file, output, sendProgress);
  }
  return upscaleVideo(workspace.ffmpeg, file, output, pct => sendProgress(Math.round(pct * 100)));
}
const keyLinks = { mini: 'https://platform.minimax.io', deep: 'https://platform.deepseek.com' };
function windowOpen() {
  window = new BrowserWindow({
    width: 1380, height: 900, minWidth: 960, minHeight: 710, backgroundColor: '#17191d',
    title: '短剧成片工作室', autoHideMenuBar: true, icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11' && !input.isAutoRepeat) {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    }
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  void window.loadFile(path.join(__dirname, '..', 'ui', 'index.html'));
  window.on('closed', () => { window = null; });
}
async function serve(request) {
  try {
    const url = new URL(request.url);
    const [id, item = ''] = url.pathname.slice(1).split('/').map(decodeURIComponent);
    const file = workspace.pathFor(url.hostname, id, item);
    const size = (await fs.stat(file)).size;
    const audio = { '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg' };
    const headers = { 'Content-Type': imageType(file) || audio[path.extname(file)] || 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    let start = 0, end = size - 1, status = 200;
    const range = request.headers.get('range');
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416 });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
      if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
      status = 206;
      headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
    }
    headers['Content-Length'] = String(end - start + 1);
    return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, { start, end })), { status, headers });
  } catch { return new Response(null, { status: 404 }); }
}
function handle(name, callback) {
  ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, error: '请求来源无效。' };
    }
    try { return { ok: true, value: await callback(...args) }; }
    catch (error) {
      const code = error.code ?? error.status;
      return { ok: false, diagnostic: error.diagnostic, error: code === 'ENOSPC' ? '磁盘空间不足，请释放空间。' :
        (error.message || '处理失败。') + (code ? '（' + code + '）' : '') };
    }
  });
}
function attachHandlers() {
  handle('state', () => ({ ...workspace.snapshot(), appVersion: app.getVersion() }));
  handle('import', async (file) => {
    if (!file) {
      const choice = await dialog.showOpenDialog(window, { title: '导入画布 ZIP', properties: ['openFile'],
        filters: [{ name: '画布导出包', extensions: ['zip'] }] });
      if (choice.canceled) return null;
      file = choice.filePaths[0];
    }
    if (path.extname(file).toLowerCase() !== '.zip') throw Error('请选择画布导出的 ZIP 文件。');
    return workspace.import(file);
  });
  handle('remove', async id => {
    const project = workspace.project(id);
    const result = await dialog.showMessageBox(window, { type: 'warning', buttons: ['取消', '删除项目'],
      defaultId: 0, cancelId: 0, message: '删除「' + project.canvasName + '」？', detail: '导入的素材和工作室内生成的视频将被移除。' });
    if (result.response === 1) await workspace.remove(id);
    return result.response === 1;
  });
  handle('settings', input => workspace.setSettings(input));
  handle('test', kind => workspace.testConnection(kind));
  handle('refresh-models', kind => workspace.refreshModels(kind));
  handle('cleanup-versions', id => workspace.cleanupOldVersions(id));
  handle('key-link', kind => keyLinks[kind] && shell.openExternal(keyLinks[kind]));
  handle('queue', (id, segment, part) => workspace.queue(id, segment, part));
  handle('preflight', (id, segment, part, mode) => workspace.preflight(id, segment, part, mode));
  handle('sample', (id, segment, part) => workspace.queueSample(id, segment, part));
  handle('edit-shot', (id, segment, shot, input) => workspace.editShot(id, segment, shot, input));
  handle('edit-bindings', (id, segment, input) => workspace.editBindings(id, segment, input));
  handle('diagnose', (id, segment, withImages, model) => workspace.diagnose(id, segment, withImages, model));
  handle('apply-diagnosis', (id, token, indices) => workspace.applyDiagnosis(id, token, indices));
  handle('fullscreen', () => window.setFullScreen(!window.isFullScreen()));
  handle('replace-art', async (id, group, assetId, reset) => {
    if (reset) { await workspace.replaceArt(id, group, assetId, null); return true; }
    const choice = await dialog.showOpenDialog(window, { title: '选择本地参考图', properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] });
    if (choice.canceled) return false;
    await workspace.replaceArt(id, group, assetId, choice.filePaths[0]);
    return true;
  });
  handle('redo', (id, part) => workspace.redo(id, part));
  handle('select-clip', (id, part, version) => workspace.selectClip(id, part, version));
  handle('mix', (id, mix) => workspace.setMix(id, mix));
  handle('resume', () => workspace.resume());
  handle('retry', (id, part, remote) => workspace.retry(id, part, remote));
  handle('edit', (id, segment, lines, mode) => workspace.edit(id, segment, lines, mode));
  handle('undo', (id, segment) => workspace.undo(id, segment));
  handle('reassemble', id => workspace.reassemble(id));
  handle('music', async (id, clear) => {
    if (clear) return workspace.setMusic(id, null);
    const result = await dialog.showOpenDialog(window, { title: '选择本地背景配乐', properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'] }] });
    if (!result.canceled) return workspace.setMusic(id, result.filePaths[0]);
  });
  handle('adopt-hd', async (id, part) => {
    const { version } = workspace.clipSource(id, part);
    const result = await dialog.showOpenDialog(window, { title: '选择这个子段已有的高清 MP4', properties: ['openFile'],
      filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
    if (result.canceled) return false;
    if (path.extname(result.filePaths[0]).toLowerCase() !== '.mp4') throw Error('请选择 MP4 文件。');
    return workspace.adoptHD(id, part, result.filePaths[0], 'imported', version);
  });
  handle('enhance-clip', async (id, part, method) => {
    if (typeof part !== 'string' || !/^(sample-)?\d+-\d+$/.test(part)) throw Error('请选择已完成的视频。');
    if (!['seedvr2', 'ffmpeg'].includes(method)) throw Error('请选择高清处理方式。');
    if (hdExporting) throw Error('另一个高清任务正在处理。');
    if (workspace.rendering.has(id)) throw Error('整集正在拼接，请完成后再转高清。');
    const source = workspace.clipSource(id, part);
    hdExporting = true;
    let staging;
    try {
      staging = await fs.mkdtemp(path.join(workspace.downloads, '.enhance-'));
      const output = path.join(staging, 'clip.mp4');
      await runHD(method, source.file, output);
      return await workspace.adoptHD(id, part, output, method, source.version);
    } finally {
      if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      hdExporting = false;
    }
  });
  handle('export', async (type, id, item, method) => {
    if (!['clip', 'episode', 'hd'].includes(type)) throw Error('只能导出视频。');
    const hd = type === 'hd';
    const ai = hd && method === 'seedvr2';
    const clip = type === 'clip';
    const [part = '', variant] = typeof item === 'string' ? item.split(':') : [];
    const sample = /^sample-\d+-\d+$/.test(part);
    if (hd && hdExporting) throw Error('正在处理另一个高清导出，请等它完成。');
    const file = workspace.pathFor(clip ? 'clip' : 'episode', id, item);
    const title = workspace.project(id).title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80).replace(/[. ]+$/, '') || '成片';
    const clipName = (sample ? '-小样-' + part.slice(7) : '-子段-' + part) + (variant === 'original' ? '-原版' : '');
    const name = title + (clip ? clipName : '') + (ai ? '-SeedVR2高清' : hd ? '-本地高清' : '') + '.mp4';
    if (hd) hdExporting = true;
    try {
      const result = await dialog.showSaveDialog(window, { title: hd ? '保存高清 MP4' : '保存 MP4', defaultPath: name,
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }] });
      if (result.canceled) return false;
      if (hd) return await runHD(method, file, result.filePath);
      if (path.resolve(file) !== path.resolve(result.filePath)) await fs.copyFile(file, result.filePath);
      return true;
    } finally { if (hd) hdExporting = false; }
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(() => {
    const ffmpeg = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'ffmpeg.exe') :
      path.join(__dirname, '..', 'build', 'runtime', 'ffmpeg.exe');
    workspace = new Workspace({ root: path.join(app.getPath('userData'), 'data'), secureStorage: safeStorage, ffmpeg });
    protocol.handle('studio', serve);
    attachHandlers();
    windowOpen();
    workspace.start();
  }).catch(error => { dialog.showErrorBox('无法打开短剧成片工作室', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => workspace?.stop());
}

