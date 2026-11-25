'use strict';
const $ = selector => document.querySelector(selector);
const work = $('#workspace');
const dialog = $('#modal');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const E = escapeHtml;
const labels = { queued: '本地排队', submitting: '提交给 MiniMax', remote: '云端已接收', done: '已完成', failed: '失败', uncertain: '需核对提交' };
const remoteLabels = { queued: '云端排队', pending: '云端排队', running: '云端生成中', processing: '云端生成中', downloading: '下载到本机' };
const isActive = job => ['queued', 'submitting', 'remote'].includes(job?.status);
function jobStatus(job) {
  if (!job) return '未提交';
  if (job.status === 'queued' && state.hold) return '已暂停';
  if (job.preparing) return '本地准备素材';
  if (job.status === 'remote' && job.error?.code === 'NETWORK') return '等待重新连接';
  return (job.status === 'remote' && remoteLabels[job.remoteState]) || labels[job.status] || job.status;
}
function statusLabel(value, active) {
  return '<span class="job-status' + (active ? ' job-status-active' : '') + '">' + E(value) + '</span>';
}
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
const url = (kind, id, item = '') => 'studio://' + kind + '/' + encode(id) + '/' + encode(item);
const seconds = value => Number(value.toFixed(2)) + ' 秒';
const money = value => (value / 1024 ** 2).toFixed(1) + ' MB';
const measure = shots => shots.reduce((sum, shot) => sum + shot.durationSec, 0);
let state = { projects: [], settings: {} };
let current = '';
let selection = 1;
let timelineFocus = false;
let openModal = '';
let signature = '';
let refreshing = false;
let toastTimer;
let importPending = false;

async function invoke(name, ...args) {
  const result = await window.studio.invoke(name, ...args);
  if (!result.ok) { const error = Error(result.error); error.diagnostic = result.diagnostic; throw error; }
  return result.value;
}
function notify(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = error ? 'error' : '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.textContent = ''; }, error ? 8300 : 4100);
}
function project() { return state.projects.find(item => item.id === current); }
function pick() {
  const p = project();
  const seg = p?.segments.find(segment => segment.shots.some(shot => shot.shotIndex === selection)) || p?.segments[0];
  return { seg, shot: seg?.shots.find(item => item.shotIndex === selection) || seg?.shots[0] };
}
function button(label, action, options = '') {
  return '<button type="button" data-action="' + action + '" ' + options + '>' + label + '</button>';
}
function selectOptions(values, current) {
  return values.map(([value, label]) => '<option value="' + E(value) + '"' + (value === current ? ' selected' : '') + '>' + E(label) + '</option>').join('');
}
function renderProjects() {
  const markup = state.projects.map(p => button('<strong>' + E(p.canvasName) + '</strong><span>v' + (p.revision || 1) + ' · ' +
    p.segments.length + ' 段 · ' + p.segments.reduce((sum, s) => sum + s.shots.length, 0) + ' 镜</span>',
  'project', 'class="project-button ' + (p.id === current ? 'active' : '') + '" data-id="' + E(p.id) + '"')).join('');
  if ($('#projects').innerHTML !== markup) $('#projects').innerHTML = markup;
}
function segmentTile(p, seg, active) {
  const jobs = seg.parts.map(part => p.jobs[part.id]);
  const states = jobs.map(job => job?.status);
  const generating = jobs.find(isActive);
  const sampling = seg.parts.map(part => p.jobs['sample-' + part.id]).find(isActive);
  const status = seg.problem ? '需调整时长' : states.length && states.every(item => item === 'done') ? '已完成' :
    generating ? jobStatus(generating) :
    states.some(item => ['failed', 'uncertain'].includes(item)) ? '需要处理' :
    states.some(Boolean) ? '生成队列中' : '未生成';
  const image = p.images[seg.gridImage] ? 'background-image:url(' + url('image', p.id, seg.gridImage) + ');' : '';
  const positions = ['0% 0%', '100% 0%', '0% 100%', '100% 100%'];
  const tiles = seg.shots.map(shot => button('<span class="photo" style="' + image + 'background-position:' + positions[shot.cell] +
    '"></span><span class="cap">#' + shot.shotIndex + ' · ' + E(shot.framing || '—') + ' · ' + shot.durationSec + 's</span>',
  'shot', 'class="tile ' + (shot.shotIndex === selection ? 'selected' : '') + '" data-shot="' + shot.shotIndex +
    '" title="第 ' + shot.shotIndex + ' 镜 · ' + E(shot.framing) + ' · ' + E(seconds(shot.durationSec)) + '"')).join('');
  return '<article class="segment ' + (active === seg.index ? 'selected' : '') + '" data-segment="' + seg.index + '"><header class="seg-head"><b>第 ' +
    seg.index + ' 段</b><span class="mono">' + E(seconds(measure(seg.shots))) + '</span></header><div class="tiles">' + tiles +
    '</div><span class="seg-state">' + statusLabel(status, Boolean(generating) && !state.hold) +
    (sampling ? statusLabel('小样 · ' + jobStatus(sampling), !state.hold) : '') + '</span></article>';
}
function tags(p, items) {
  return items.map(item => '<span class="tag" title="' + E(item.description) + '">' +
    (p.images[item.image] ? '<img alt="" src="' + url('image', p.id, item.image) + '">' : '') + E(item.name) + '</span>').join('');
}
function inspector(p, seg, shot) {
  if (!shot) return '';
  const dialogue = shot.dialogue?.text?.trim() ? '<p class="dialogue"><small>台词</small>💬 ' +
    E((shot.dialogue.speaker ? shot.dialogue.speaker + '：' : '') + shot.dialogue.text) + '</p>' : '<p class="muted">无台词</p>';
  const { characters, assets } = seg.bindings;
  const groups = [['人物', characters], ['场景', assets.filter(item => item.kind === '场景')],
    ['道具', assets.filter(item => item.kind !== '场景')]];
  const bindings = '<section class="inspector-bindings" aria-label="本段绑定资源"><div class="binding-header"><h3>本段绑定资源</h3>' +
    (seg.bindingOverrides ? '<span class="muted">手动</span>' : '') + button('编辑绑定', 'binding-edit') +
    button('换图', 'art-library', 'aria-label="替换美术资源图片"') + '</div>' +
    groups.map(([label, items]) => '<div class="binding-row"><small>' + label + '</small><div class="tags">' +
      (tags(p, items) || '<span class="muted">未绑定</span>') + '</div></div>').join('') + '</section>';
  return '<aside class="panel inspector"><header class="panel-head"><h2>第 ' + shot.shotIndex +
    ' 镜</h2><div class="panel-tools"><span class="mono muted">' + E(seconds(shot.durationSec)) + '</span>' +
    button('编辑分镜', 'shot-edit') + '</div></header>' + bindings + '<div class="inspect-body">' +
    '<p><small>画面 · ' + E(shot.framing) + '</small>' + E(shot.visual || '—') + '</p>' +
    '<p><small>分镜提示词</small>' + E(shot.prompt || '—') + '</p>' + dialogue +
    '<p><small>运镜</small>' + E(shot.camera || '—') + '</p><p><small>音效</small>' + E(shot.sfx || '—') + '</p>' +
    (seg.gridPrompt ? '<p><small>四宫格总提示词</small>' + E(seg.gridPrompt) + '</p>' : '') + '</div></aside>';
}
function queuePanel(p, allParts) {
  const rows = allParts.map(part => {
    const job = p.jobs[part.id];
    const stateClass = ['failed', 'uncertain'].includes(job?.status) ? 'red' : job?.status === 'done' ? 'green' : 'muted';
    const status = statusLabel(jobStatus(job), isActive(job) && !state.hold);
    const data = 'data-part="' + part.id + '"';
    const sampleId = 'sample-' + part.id;
    const sample = p.jobs[sampleId];
    const sampleData = 'data-part="' + sampleId + '"';
    const sampleActions = !sample ? button('480P 小样', 'sample-check', data) :
      sample.status === 'done' ? button('看小样', 'clip', sampleData) + button('小样转高清', 'hd-check', sampleData) +
        button('再做小样', 'sample-check', data) :
      ['failed', 'uncertain'].includes(sample.status) ? button('处理小样', 'retry', sampleData) : '';
    const controls = (job?.usable ? button(job.activeHD ? '预览高清' : '预览', 'clip', data) : '') +
      (job?.usable && job.versions?.length ? button('版本对比', 'versions', data) : '') +
      (!job ? button('生成子段', 'part-check', data) : '') +
      (job?.status === 'done' ? button('重做', 'redo-check', data) : '') +
      (['failed', 'uncertain'].includes(job?.status) ? button(job.status === 'uncertain' ? '核对' : '重试', 'retry', data) : '');
    const detail = '#' + part.shots.map(shot => shot.shotIndex).join('、#') + ' · ' + part.duration + ' 秒' +
      (job?.reused ? ' · 已复用' : '') + (job ? ' · ' + job.settings.resolution + (job.attempts.length ? ' · 已提交 ' + job.attempts.length + ' 次' : '') : '');
    return '<div class="queue-row"><div><b>子段 ' + part.id + '</b><div class="' + stateClass + '">' + status +
      '</div></div><div class="detail muted">' + E(detail) +
      (job?.activeHD ? '<div class="green">已采用高清 · ' + E(job.activeHD.width + ' × ' + job.activeHD.height) + '</div>' : '') +
      (job?.error ? '<div class="red">' + E(job.error.message + (job.error.code ? '（' + job.error.code + '）' : '')) + '</div>' : '') +
      (job && job.prompt !== part.prompt ? '<div class="yellow">分镜提示已更新，可重做应用到新视频。</div>' : '') +
      (job?.refs && part.refs && JSON.stringify(job.refs) !== JSON.stringify(part.refs) ?
        '<div class="yellow">参考素材已更新，可重做应用到新视频。</div>' : '') +
      (sample ? '<div class="sample-status">480P 小样 · ' + statusLabel(jobStatus(sample), isActive(sample) && !state.hold) +
        (sample.activeHD ? ' · 已采用高清' : '') +
        (sample.attempts?.length ? ' · 提交 ' + sample.attempts.length + ' 次' : '') +
        (sample.error ? ' · ' + E(sample.error.message + (sample.error.code ? '（' + sample.error.code + '）' : '')) : '') + '</div>' : '') +
      '</div><div class="controls">' + controls + sampleActions + '</div></div>';
  }).join('');
  const done = allParts.filter(part => p.jobs[part.id]?.usable).length;
  return '<section class="panel"><header class="panel-head"><h2>生成队列</h2><span class="mono muted">' + done + ' / ' +
    allParts.length + ' 已完成</span></header><div class="queue-scroll">' + (rows || '<div class="empty-small">请先在画布调整分段。</div>') + '</div></section>';
}
function resultPanel(p, allParts) {
  const result = p.episode;
  let content = '<p class="muted">子段全部生成后，整集 MP4 会在这里出现。</p>';
  if (result.status === 'rendering') content = '<div class="bar"><i style="width:65%"></i></div><p>' + E(result.stage) + '</p>';
  if (result.status === 'waiting') content = '<p class="muted">等待全部子段完成。失败的子段可在队列单独处理。</p>';
  if (result.status === 'error') content = '<p class="red">' + E(result.message) + '</p>';
  if (result.status === 'done') content = '<video id="episode-player" controls preload="metadata" src="' +
    url('episode', p.id, result.name) + '"></video><p class="muted">' + E(seconds(result.duration)) + ' · ' +
    result.width + ' × ' + result.height + ' · ' + E(money(result.size)) + '</p>' +
    button('验片定位', 'review') + button('保存整集 MP4', 'save-episode', 'class="primary"') +
    (result.width < (result.height >= result.width ? 1080 : 1920) && result.height < (result.height >= result.width ? 1920 : 1080)
      ? button('本地转高清', 'hd-check') : '') +
    (result.mix ? '<p class="muted">字幕 ' + (result.mix.subtitles ? '开启' : '关闭') + ' · 拟音 ' +
      (result.mix.effects ? '开启' : '关闭') + ' · 配乐 ' + E(result.music || '关闭') + '</p>' : '') +
    (result.rebuildError ? '<p class="red">重新拼接失败，仍可播放上一次成片。' + E(result.rebuildError) + '</p>' : '') +
    (p.dirty ? '<p class="notice">采用的片段或导出设置已更新，请重新拼接。</p>' : '');
  const canRebuild = allParts.length > 0 && !p.segments.some(seg => seg.problem) && allParts.every(part => p.jobs[part.id]?.usable) && result.status !== 'rendering';
  return '<section class="panel"><header class="panel-head"><h2>整集成片</h2><span class="mono muted">MP4</span></header><div class="result">' +
    content + '<p class="muted">' + (p.music ? '配乐 · ' + E(p.music) : '配乐 · 关闭') + '</p><div class="small-buttons">' +
    button('字幕与音轨', 'mix-settings') +
    (canRebuild ? button('重新拼接', 'reassemble') : '') + '</div></div></section>';
}
function render() {
  renderProjects();
  const p = project();
  const key = JSON.stringify([p, selection, timelineFocus, state.hold, state.queueError, state.settings.resolution]);
  if (signature === key) return;
  signature = key;
  if (!p) {
    work.innerHTML = '<div class="empty"><div class="drop"><div class="empty-icon" aria-hidden="true"><i></i><i></i><i></i><i></i></div>' +
      '<h1>导入画布，生成整集</h1><p>拖入从短剧创作画布导出的项目 ZIP。</p>' +
      button('选择画布 ZIP', 'import', 'class="primary"') + '</div></div>';
    return;
  }
  const loneRed = p.check.issues.filter(item => item.level === 'red').length;
  const loneYellow = p.check.issues.length - loneRed;
  const { seg, shot } = pick();
  const allParts = p.segments.flatMap(segment => segment.parts);
  const timelineScroll = $('.timeline')?.scrollLeft || 0;
  const timelineTop = $('.timeline')?.scrollTop || 0;
  const queueScroll = $('.queue-scroll')?.scrollTop || 0;
  const inspectScroll = $('.inspect-body')?.scrollTop || 0;
  const existingVideo = $('#episode-player');
  const runningText = state.hold || state.queueError;
  const newCount = allParts.filter(part => !p.jobs[part.id]).length;
  const activeCount = Object.values(p.jobs).filter(isActive).length;
  const generateLabel = p.episode.status === 'done' ? '整集已生成' : '检查并生成整集';
  work.innerHTML = '<div class="content' + (timelineFocus ? ' timeline-focus' : '') + '"><header class="overview"><div><h1>' + E(p.title) +
    '</h1><div class="canvas">' + E(p.canvasName) + '</div></div><div class="actions">' +
    button('清理旧版', 'cleanup-versions', 'class="subtle"') + button('删除', 'remove', 'class="subtle"') + button(generateLabel, 'queue-all', 'class="primary" ' + (p.episode.status === 'done' ? 'disabled' : '')) +
    '</div></header><div class="facts"><span><b>' + p.segments.length + '</b>段</span><span><b>' +
    p.segments.reduce((sum, item) => sum + item.shots.length, 0) + '</b>镜</span><span><b>' + E(seconds(measure(p.segments.flatMap(item => item.shots)))) +
    '</b>总长</span><span><b>' + Object.keys(p.images).length + '</b>张图</span><span><b>' + newCount +
    '</b>个待提交子段</span>' + (activeCount ? '<span role="status">' +
      statusLabel(activeCount + (state.hold ? ' 个任务待恢复' : ' 个任务处理中'), !state.hold) + '</span>' : '') +
    '<div class="checks">' + button(loneRed ? loneRed + ' 项问题' : loneYellow ? loneYellow + ' 项提醒' : '一致性通过', 'checks',
    'class="check-button ' + (loneRed ? 'red' : loneYellow ? 'yellow' : 'green') + '"') + '</div></div>' +
    (runningText ? '<p class="notice">' + E(runningText) + ' ' + button('打开设置', 'settings', 'class="quiet"') + '</p>' : '') +
    '<div class="editing"><section class="panel"><header class="panel-head"><h2>分镜时间线</h2><div class="panel-tools">' +
    button(timelineFocus ? '退出放大' : '放大编辑', 'timeline-focus', 'aria-pressed="' + timelineFocus + '"') +
    button('提示词工作台', 'prompt') + button('生成本段', 'queue-one') +
    '</div></header><div class="timeline">' + p.segments.map(segment => segmentTile(p, segment, seg.index)).join('') +
    '</div></section>' + inspector(p, seg, shot) + '</div>' + (timelineFocus ? '' :
      '<div class="lower">' + queuePanel(p, allParts) + resultPanel(p, allParts) + '</div>') + '</div>';
  $('.timeline').scrollLeft = timelineScroll;
  $('.timeline').scrollTop = timelineTop;
  if ($('.queue-scroll')) $('.queue-scroll').scrollTop = queueScroll;
  if ($('.inspect-body')) $('.inspect-body').scrollTop = inspectScroll;
  if (existingVideo && $('#episode-player')?.src === existingVideo.src) $('#episode-player').replaceWith(existingVideo);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await invoke('state');
    $('#app-version').textContent = state.appVersion ? '软件 v' + state.appVersion : '';
    if (!project()) {
      current = state.projects[0]?.id || '';
      selection = 1;
    }
    render();
  } finally { refreshing = false; }
}
function modal(title, body, footer = '', kind = '') {
  openModal = kind;
  dialog.innerHTML = '<header class="modal-head"><h2>' + E(title) + '</h2>' + button('关闭', 'close', 'class="subtle"') +
    '</header><div class="modal-body">' + body + '</div>' + (footer ? '<footer class="modal-foot"><span id="modal-status" class="status"></span>' + footer + '</footer>' : '');
  if (!dialog.open) dialog.showModal();
}
function close() { if (dialog.open) dialog.close(); openModal = ''; }
const fieldSelect = (id, title, values, selected) => '<label class="field">' + E(title) + '<select id="' + id + '">' +
  selectOptions(values, selected) + '</select></label>';
function keyField(id, title, suffix, text) {
  return '<div class="key-section"><h3>' + E(title) + ' Key <span class="muted" id="' + id + '-key-status">' + (suffix ? ' · ••••' + E(suffix) : ' · 未设置') +
    '</span></h3><div class="key-line"><input id="' + id + '" type="password" placeholder="填写新 Key" aria-label="' + E(title) +
    ' Key" autocomplete="off"><label><input id="' + id + '-clear" type="checkbox"> 清除</label>' +
    button('测试连接', 'test', 'data-kind="' + id + '"') + '</div><p>' + E(text) + ' ' +
    button('申请 Key', 'key-link', 'class="link" data-kind="' + id + '"') + '</p></div>';
}
function settings() {
  const s = state.settings;
  const sets = [keyField('mini', 'MiniMax', s.miniSuffix, 'H3 需要按量付费 Key。'),
    keyField('deep', 'DeepSeek', s.deepSuffix, '用于提示词优化和一致性分析。')];
  modal('设置', sets.join('') + '<div class="settings-grid">' +
    fieldSelect('site', 'MiniMax 站点', [['https://api.minimax.io','国际站'], ['https://api.minimax.cn','大陆站']], s.base) +
    fieldSelect('mini-model', 'MiniMax 视频模型', modelOptions(s.miniModels, ''), s.miniModel) +
    fieldSelect('resolution', '视频分辨率', modelOptions(s.miniVideoOptions[s.base][s.miniModel].resolutions, ''), s.resolution) +
    fieldSelect('ratio', '画幅', ratioOptions(s.miniVideoOptions[s.base][s.miniModel].adaptive), s.ratio) +
    fieldSelect('transition', '子段衔接', [['dissolve','短叠化 · 0.2 秒'],['cut','直接切换']], s.transition) +
    fieldSelect('deep-model', 'DeepSeek 模型', modelOptions(s.deepModels, '保存 Key 后自动获取'), s.deepModel) +
    '<label class="field">同时生成子段数<input id="concurrency" type="number" min="1" max="6" value="' + s.concurrency + '"></label></div>' +
    '<p class="muted">MiniMax 型号按所选站点的官方视频 V2 文档显示，实际生成权限由该站点和 Key 决定。大陆站 480P 小样可用 H3 Lite、Highspeed 或 Max。</p>' +
    '<p class="muted">打开设置或保存新的 DeepSeek Key 后会拉取 DeepSeek 模型列表。</p>' +
    '<label class="switch"><input id="h3-audio" type="checkbox" ' + (s.generateAudio ? 'checked' : '') + '> 保留 MiniMax 原生声音</label>' +
    '<label class="switch"><input id="fx" type="checkbox" ' + (s.effects ? 'checked' : '') + '> 自动混入分镜音效</label>',
    (state.hold ? button('恢复队列', 'resume') : '') + button('保存并刷新 DeepSeek 模型', 'refresh-models') +
    button('保存设置', 'save-settings', 'class="primary"'), 'settings');
  $('#site').addEventListener('change', syncMiniVideoOptions);
  $('#mini-model').addEventListener('change', syncMiniVideoOptions);
}
const modelOptions = (models, emptyLabel) => (models && models.length ? models.map(m => [m, m]) : [['', emptyLabel]]);
const ratioOptions = adaptive => [
  ['9:16', '9:16 竖屏'], ['16:9', '16:9 横屏'], ['1:1', '1:1 方形'],
  ...(adaptive ? [['adaptive', '跟随参考图']] : []),
];
function syncMiniVideoOptions() {
  const options = state.settings.miniVideoOptions[$('#site').value];
  const model = $('#mini-model');
  const selected = Object.hasOwn(options, model.value) ? model.value : 'MiniMax-H3';
  model.innerHTML = selectOptions(modelOptions(Object.keys(options), ''), selected);
  const { resolutions, adaptive } = options[selected];
  const resolution = $('#resolution');
  resolution.innerHTML = selectOptions(modelOptions(resolutions, ''), resolutions.includes(resolution.value) ? resolution.value : '768P');
  const ratio = $('#ratio');
  ratio.innerHTML = selectOptions(ratioOptions(adaptive), !adaptive && ratio.value === 'adaptive' ? '9:16' : ratio.value);
}
async function refreshModelLists(kinds = ['deep']) {
  const status = $('#modal-status');
  const notes = [];
  if (status && openModal === 'settings') status.textContent = '正在获取模型列表…';
  for (const kind of kinds) {
    if (!state.settings[kind + 'Suffix']) continue;
    try {
      const result = await invoke('refresh-models', kind);
      state.settings[kind + 'Models'] = result.models;
      state.settings[kind + 'Model'] = result.model;
      const select = $('#' + kind + '-model');
      if (select && $('#modal-status') === status && openModal === 'settings') {
        const selected = result.models.includes(select.value) ? select.value : result.model;
        select.innerHTML = selectOptions(modelOptions(result.models, ''), selected);
      }
      notes.push((kind === 'mini' ? 'MiniMax' : 'DeepSeek') + ' ' + result.models.length + ' 个模型，当前 ' + result.model);
    } catch (error) { notes.push((kind === 'mini' ? 'MiniMax' : 'DeepSeek') + ' 刷新失败：' + (error.message || error)); }
  }
  if (status && $('#modal-status') === status && openModal === 'settings') status.textContent = notes.join('；') || '请先填写 Key。';
  return notes;
}
function settingsInput() {
  return {
    mini: $('#mini').value, deep: $('#deep').value, miniClear: $('#mini-clear').checked, deepClear: $('#deep-clear').checked,
    base: $('#site').value, resolution: $('#resolution').value, ratio: $('#ratio').value, transition: $('#transition').value,
    miniModel: $('#mini-model').value, deepModel: $('#deep-model').value, concurrency: $('#concurrency').valueAsNumber,
    generateAudio: $('#h3-audio').checked, effects: $('#fx').checked,
  };
}
async function saveSettings() {
  const status = $('#modal-status');
  state.settings = await invoke('settings', settingsInput());
  if ($('#modal-status') === status && openModal === 'settings') {
    $('#mini').value = '';
    $('#deep').value = '';
    $('#mini-clear').checked = false;
    $('#deep-clear').checked = false;
    for (const kind of ['mini', 'deep']) {
      const suffix = state.settings[kind + 'Suffix'];
      $('#' + kind + '-key-status').textContent = suffix ? ' · ••••' + suffix : ' · 未设置';
    }
  }
}
function checks() {
  const p = project();
  const issues = [...p.check.issues].sort((a, b) => a.level.localeCompare(b.level));
  const issue = issues.map(item => button('<span class="' + item.level + '">' + (item.level === 'red' ? '问题' : '提醒') +
    '</span> · 第 ' + item.segment + ' 段' + (item.shot ? ' / 第 ' + item.shot + ' 镜' : '') + ' · ' + E(item.message),
  'locate', 'class="issue" data-segment="' + item.segment + '" data-shot="' + (item.shot || '') + '"')).join('');
  const missing = p.check.missing.length ? '<details><summary>缺失图片清单</summary><ul>' +
    p.check.missing.map(file => '<li>' + E(file) + '</li>').join('') + '</ul></details>' : '';
  const segments = [...new Set(issues.map(item => item.segment))];
  const options = segments.map(n => [String(n), '第 ' + n + ' 段 · ' + issues.filter(item => item.segment === n).length + ' 项']).map(([value, label]) =>
    '<option value="' + value + '">' + E(label) + '</option>').join('');
  const vision = model => ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'].includes(model);
  const models = (state.settings.deepModels || []).map(model => [model, model + (vision(model) ? ' · 支持看图' : ' · 文字分析')]);
  const analysis = segments.length ? '<div class="key-section"><label class="field">分析范围<select id="analysis-segment">' + options +
    '</select></label>' + fieldSelect('analysis-model', '分析模型', models, state.settings.deepModel) +
    '<label class="switch"><input type="checkbox" id="analysis-images"> 同时分析四宫格和相关定妆照</label>' +
    '<p class="muted">分析会把所选段的检查项、分镜和人物信息发给 DeepSeek。选用支持看图的模型后可附上图片。</p></div>' : '';
  modal('一致性检查', analysis + (issue || '<p class="green">全部通过。</p>') + missing,
    segments.length ? button(state.settings.deepSuffix ? 'DeepSeek 分析' : '设置 DeepSeek Key',
      state.settings.deepSuffix ? 'diagnose' : 'settings', 'class="primary"') : '', 'checks');
  if (segments.length) {
    const model = $('#analysis-model');
    const images = $('#analysis-images');
    const sync = () => {
      images.disabled = !vision(model.value);
      if (images.disabled) images.checked = false;
    };
    model.addEventListener('change', sync);
    sync();
  }
}
function diagnosisReview(segment, report) {
  const choices = report.proposals.map((item, index) => '<section class="key-section">' +
    '<label class="switch"><input type="checkbox" data-proposal="' + index + '"> ' +
    E(item.kind === 'shot' ? '第 ' + item.shot + ' 镜' : item.kind === 'cast' ? '补充人物绑定' : '标记为无人物段') +
    '</label><p>' + E(item.reason) + '</p>' + (item.changes ?
      item.changes.map(change => '<div class="diagnostic-change"><strong>' + E(change.label) +
        '</strong><div>当前 · ' + E(change.before || '空') + '</div><div>建议 · ' + E(change.after) + '</div></div>').join('') :
      '<div class="diagnostic-change">建议 · ' + E(item.after) + '</div>') + '</section>').join('');
  const source = report.hasGrid ? '已分析四宫格 · ' + report.images + ' 张图片' : '未分析四宫格，请结合画面核对';
  modal('第 ' + segment + ' 段 · DeepSeek 分析',
    '<p class="muted">' + E(report.model + ' · ' + source) + '</p><p class="diagnostic-change">' + E(report.summary) + '</p>' +
    (choices || '<p class="muted">暂无可应用的修复，请按分析结论检查素材。</p>'),
    button('返回检查', 'checks') + (choices ? button('应用所选修复', 'apply-diagnosis',
      'class="primary" data-token="' + E(report.token) + '"') : ''), 'diagnosis');
}
function prompts() {
  const p = project(), { seg } = pick();
  const edits = p.edits[seg.index] || [];
  const status = edits.at(-1)?.mode === 'deep' ? 'DeepSeek 优化' : edits.length ? '手动编辑' : '画布原稿';
  modal('第 ' + seg.index + ' 段 · 提示词工作台', '<p class="muted">' + status + ' · ' + edits.length + ' 个历史版本</p>' +
    (seg.gridPrompt ? '<p><small>四宫格总提示词</small>' + E(seg.gridPrompt) + '</p>' : '') +
    (seg.problem ? '<p class="red">' + E(seg.problem) + '</p>' : '') +
    seg.parts.map(part => '<h3>子段 ' + part.id + '</h3><pre class="prompt-preview">' + E(part.prompt) + '</pre>').join('') +
    '<details><summary>编辑逐镜画面与运镜</summary><p class="muted">台词、格位、时长和资产锁由画布数据固定。</p>' +
    seg.shots.map(shot => '<label class="field">第 ' + shot.shotIndex + ' 镜<textarea data-edit="' + shot.shotIndex + '">' +
      E(edits.at(-1)?.lines[shot.shotIndex] || [shot.camera, shot.visual, shot.prompt].filter(Boolean).join('；')) + '</textarea></label>').join('') + '</details>',
    button('DeepSeek 优化', 'optimize') + (edits.length ? button('回退一版', 'undo') : '') + button('保存编辑', 'save-prompt', 'class="primary"'), 'prompt');
}
async function confirmQueue(segment, part, mode = 'normal') {
  const { blockers, ready, reviews, reused, reusedClips, settings } = await invoke('preflight', current, segment, part, mode);
  const grouped = [...Map.groupBy(reviews, issue => issue.message)].map(([message, entries]) =>
    '<details><summary>' + E(message) + ' · ' + entries.length + ' 处</summary>' + entries.map(issue =>
      button('第 ' + issue.segment + ' 段' + (issue.shot ? ' / ' + issue.shot + ' 镜' : ''), 'locate',
        'data-segment="' + issue.segment + '" data-shot="' + (issue.shot || '') + '"')).join(' ') + '</details>').join('');
  const references = ready.map(item => '<details><summary>子段 ' + E(item.id) + ' · ' + item.duration + ' 秒 · ' + item.files.length +
    ' 张参考图</summary><ul>' + item.files.map(file => '<li>' + E(file) + '</li>').join('') + '</ul>' +
    (item.dropped.length ? '<p class="yellow">超限未提交：' + E(item.dropped.join('、')) + '</p>' : '') + '</details>').join('');
  const body = '<div class="confirm-list"><h3>必须处理 · ' + blockers.length + '</h3>' +
    (blockers.length ? '<ul class="red">' + blockers.map(item => '<li>' + E(item) + '</li>').join('') + '</ul>' : '<p class="green">无阻塞项</p>') +
    '<details><summary>建议复核 · ' + reviews.length + ' 处</summary>' + (grouped || '<p>无</p>') + '</details>' +
    (reusedClips.length ? '<details open><summary>已有可用片段 · ' + reusedClips.length + ' 个</summary><ul>' +
      reusedClips.map(clip => '<li' + (clip.hd ? ' class="green"' : '') + '>子段 ' + E(clip.id) + ' · ' +
        E(clip.hd ? '采用高清 ' + clip.hd.width + ' × ' + clip.hd.height : '采用原版 ' + (clip.resolution || '')) + '</li>').join('') +
      '</ul></details>' : '') +
    '<h3>可提交 · ' + ready.length + ' 个子段</h3><p>' + ready.reduce((sum, item) => sum + item.duration, 0) + ' 秒 · ' +
    E(settings.model || '') + ' · ' + E(settings.resolution) + ' · ' + E(settings.ratio) + ' · 已有可用片段 ' + reused + ' 个</p>' + references +
    (ready.length ? '<p>按 MiniMax 账户资费扣费，部分参考图也可能计费。</p>' : '') +
    (mode === 'redo' ? '<p>生成后可对比版本，再选入整集。</p>' : '') +
    (mode === 'sample' ? '<p>480P 小样由 MiniMax 云端生成，完成后下载到本机单独预览。</p>' : '') + '</div>';
  const attrs = 'data-part="' + E(part || '') + '" data-segment="' + (segment || '') + '"';
  const title = part ? (mode === 'sample' ? '480P 小样 · ' : mode === 'redo' ? '重做子段 · ' : '检查并生成子段 · ') + part :
    segment ? '检查第 ' + segment + ' 段' : '整集生成前检查';
  modal(title, body,
    button('取消', 'close') + (!state.settings.miniSuffix ? button('打开设置', 'settings') : '') +
    button(mode === 'redo' ? '确认重做' : '确认生成', mode === 'redo' ? 'redo-now' : mode === 'sample' ? 'sample-now' : 'start',
      'class="primary" ' + attrs + (blockers.length ? ' disabled' : '')));
}
const shotFields = [['framing', '景别'], ['visual', '画面描述'], ['prompt', '分镜提示词'], ['camera', '运镜'], ['sfx', '音效']];
function shotEditor() {
  const { shot } = pick();
  const fields = shotFields.map(([key, label]) => '<label class="field">' + label +
    '<textarea id="shot-' + key + '" maxlength="4000">' + E(shot[key]) + '</textarea></label>').join('');
  modal('编辑第 ' + shot.shotIndex + ' 镜', fields +
    '<p class="muted">画布原台词与时长保持原样。改动会用于之后提交的生成任务与本地混音。</p>',
    (shot.originalFields ? button('恢复导入内容', 'shot-reset') : '') + button('保存分镜', 'shot-save', 'class="primary"'));
}
function bindingEditor() {
  const p = project(), { seg } = pick();
  const allAssets = [...p.scenes, ...p.assets];
  const groups = [['characters', '人物', p.characters], ['scenes', '场景', allAssets.filter(item => item.kind === '场景')],
    ['props', '道具', allAssets.filter(item => item.kind !== '场景')]];
  const body = groups.map(([key, label, items]) => '<fieldset class="binding-choices"><legend>' + label + '</legend>' +
    (items.map(item => '<label><input type="checkbox" data-binding="' + key + '" value="' + E(item.id) + '"' +
      ((key === 'characters' ? seg.bindings.characters : seg.bindings.assets).some(bound => bound.id === item.id) ? ' checked' : '') + '>' + (p.images[item.image] ?
        '<img alt="" src="' + url('image', p.id, item.image) + '">' : '') +
      '<span>' + E(item.name) + (p.images[item.image] ? '' : ' · 缺参考图') + '</span></label>').join('') ||
      '<p class="muted">项目库暂无此类资源。</p>') + '</fieldset>').join('');
  modal('编辑第 ' + seg.index + ' 段的绑定', '<p class="muted">手动选择应用到本段各子段的后续生成。已有任务保留提交时的素材，设定图仍受每次最多 9 张参考图的限制。</p>' + body,
    (seg.bindingOverrides ? button('恢复自动绑定', 'binding-reset') : '') + button('保存绑定', 'binding-save', 'class="primary"'));
}
function artLibrary() {
  const p = project();
  const groups = [['人物', p.characters, 'characters'], ['场景', p.scenes, 'scenes'], ['场景与道具', p.assets, 'assets']];
  const content = groups.map(([title, items, group]) => '<fieldset class="binding-choices art-library"><legend>' + title + '</legend>' +
    (items.map(item => {
      const options = 'data-group="' + group + '" data-asset="' + E(item.id) + '"';
      const preview = p.images[item.image] ? '<img alt="" src="' + url('image', p.id, item.image) + '">' : '';
      return '<section class="art-item">' + preview + '<strong>' + E(item.name) + '</strong>' +
        (!preview ? '<small class="muted">缺参考图</small>' : '') + '<div>' + button('选择本地图片', 'art-replace', options) +
        (item.originalImage !== undefined ? button('恢复原图', 'art-reset', options) : '') + '</div></section>';
    }).join('') || '<p class="muted">暂无此类资源。</p>') + '</fieldset>').join('');
  modal('替换美术资源', '<p class="muted">换图会更新当前项目使用该资源的各段。支持 PNG、JPEG、WebP。</p>' + content,
    button('完成', 'close', 'class="primary"'), 'art');
}
function versions(part) {
  const p = project(), job = p.jobs[part];
  const entries = [...(job.versions || []), job].filter(item => item.status === 'done');
  const selected = job.selectedVersion || job.localId;
  const panels = entries.map((item, index) => {
    const active = item.localId === selected;
    const attrs = 'data-part="' + E(part) + '" data-version="' + E(item.localId) + '"';
    return '<section><h3>版本 ' + (index + 1) + (active ? ' · 当前采用' : '') + '</h3><video controls preload="metadata" src="' +
      url('clip', p.id, part + ':' + item.localId) + '"></video>' + (active ? '' : button('采用此版本', 'select-version', attrs)) + '</section>';
  }).join('');
  modal('子段 ' + part + ' · 版本对比', '<div class="version-grid">' + panels + '</div>' +
    '<p class="muted">选择其他版本后，可重新拼接更新整集。</p>',
    job.usable ? button('当前采用版转高清', 'hd-check', 'data-part="' + E(part) + '"') : '');
}
function reviewEpisode() {
  const p = project();
  let offset = 0;
  const entries = (p.episode.timeline || p.segments.flatMap(seg => seg.parts)).map(part => {
    const start = offset;
    offset += part.seconds;
    return { ...part, start, end: offset };
  });
  modal('验片定位', '<video id="review-player" class="modal-video" controls preload="metadata" src="' +
    url('episode', p.id, p.episode.name) + '"></video><p class="muted">按分镜计划时长定位，实际切镜可能偏移。</p>' +
    '<label class="field">跳到子段<select id="review-part">' + entries.map((entry, index) => '<option value="' + index + '">' +
    E(seconds(entry.start) + ' · 子段 ' + entry.id) + '</option>').join('') + '</select></label><div id="review-detail"></div>');
  const player = $('#review-player'), select = $('#review-part'), detail = $('#review-detail');
  let shown = -1;
  const update = index => {
    if (!entries[index] || index === shown) return;
    shown = index;
    select.value = String(index);
    const entry = entries[index];
    const segment = p.segments.find(item => item.index === entry.segment);
    const part = segment?.parts.find(item => item.id === entry.id);
    detail.innerHTML = '<div class="review-detail">' +
      (segment?.gridImage && p.images[segment.gridImage] ? '<img alt="四宫格参考图" src="' + url('image', p.id, segment.gridImage) + '">' : '') +
      '<div>' + (part?.shots || []).map(shot => button('第 ' + shot.shotIndex + ' 镜', 'locate',
        'data-segment="' + segment.index + '" data-shot="' + shot.shotIndex + '"')).join(' ') +
      (entry.version ? '<details><summary>成片采用的提示词</summary><pre class="prompt-preview">' + E(entry.prompt) + '</pre></details>' : '') +
      '</div></div>';
  };
  player.addEventListener('timeupdate', () => update(entries.findIndex(item => player.currentTime >= item.start && player.currentTime < item.end)));
  select.addEventListener('change', () => {
    const index = Number(select.value);
    player.currentTime = entries[index].start;
    update(index);
  });
  update(0);
}
function mixSettings() {
  const p = project(), mix = p.mix;
  const clips = Object.values(p.jobs).filter(job => job.usable).map(job => job.selectedVersion ?
    job.versions?.find(item => item.localId === job.selectedVersion) : job);
  const native = clips.filter(clip => clip?.hasAudio).length;
  const unknown = clips.filter(clip => clip?.hasAudio === undefined).length;
  const toggle = (key, label) => '<label class="switch"><input type="checkbox" id="mix-' + key + '" ' + (mix[key] ? 'checked' : '') + '> ' + label + '</label>';
  const music = p.music ? '<p>' + E(p.music) + '</p><audio id="music-preview" controls preload="none" src="' + url('music', p.id) +
    '"></audio>' : '<p class="muted">配乐关闭</p>';
  modal('字幕与音轨', toggle('subtitles', '烧录计划时间轴字幕') + toggle('nativeAudio', '保留片段已有的原生声音') +
    '<p class="muted">当前采用的片段中，' + native + ' 个有原生音轨' + (unknown ? '，' + unknown + ' 个旧片段音轨未记录' : '') + '。</p>' +
    toggle('effects', '混入分镜拟音（程序合成）') + '<p class="muted">拟音为程序合成的提示音，不是真实录音。</p>' + music + '<label class="field">配乐音量（%）<input id="mix-volume" type="number" min="0" max="100" value="' +
    mix.musicVolume + '"></label><p class="muted">配乐可单独试听。保存设置后可用已有片段重新拼接，再试听完整混音。</p>',
    button(p.music ? '更换配乐' : '选择配乐', 'music') + (p.music ? button('关闭配乐', 'music-clear') : '') +
    button('保存设置', 'save-mix', 'class="primary"'), 'mix');
  const audio = $('#music-preview');
  if (audio) {
    const volume = $('#mix-volume');
    const apply = () => { audio.volume = Math.max(0, Math.min(100, Number(volume.value))) / 100; };
    volume.addEventListener('input', apply);
    apply();
  }
}
function retry(part) {
  const jobs = project().jobs;
  const job = jobs[part];
  const sample = part.startsWith('sample-');
  const formalPart = sample ? part.slice(7) : '';
  const canUseFormal = sample && jobs[formalPart]?.usable;
  const uncertain = job.status === 'uncertain';
  const { message, code, requestId } = job.error || {};
  const title = sample ? '处理 480P 小样 · ' + formalPart : '重试子段 ' + part;
  modal(uncertain ? '核对 MiniMax 任务' : title, '<p>' + E((message || '') + (code ? '（' + code + '）' : '')) + '</p>' +
    (sample ? '<p class="muted">小样尚无可导出的视频。' +
      (canUseFormal ? '这个子段已有正式版，可直接在本机转高清。' : '小样生成完成后即可转高清。') + '</p>' : '') +
    (requestId ? '<p class="muted">MiniMax 请求 ID <span class="mono">' + E(requestId) + '</span></p>' : '') +
    (uncertain ? '<p class="notice">如 MiniMax 已接收，请填写远端任务 ID。确认没有原任务后，才重新提交。</p><label class="field">已有远端任务 ID<input id="remote-id"></label>' :
      '<p class="muted">' + (job.resumeRemote ? '继续查询 MiniMax 原任务，完成后下载到本机。' : '将重新提交给 MiniMax 云端，按服务商资费计费。') + '</p>'),
    button('取消', 'close') + (canUseFormal ? button('正式版转高清', 'hd-check', 'data-part="' + E(formalPart) + '"') : '') +
    (uncertain ? button('恢复已有任务', 'retry-remote', 'data-part="' + part + '"') : '') +
    button(uncertain ? '确认重新提交' : '确认重试', 'retry-now', 'class="primary" data-part="' + part + '"'));
}
async function importZip(file) {
  if (importPending) return;
  importPending = true;
  try {
    const result = await invoke('import', file);
    if (!result) return;
    current = result.id;
    selection = 1;
    await refresh();
    showImportDiagnostic(project()?.diagnostic, '导入成功', result.revision > 1 ?
      '已导入第 ' + result.revision + ' 版，旧版已保留。已复用：' + (result.reused.join('、') || '无') +
      '。待生成或检查：' + (result.pending.join('、') || '无') + '。' : '画布项目已导入。');
  } catch (error) {
    showImportDiagnostic(error.diagnostic, '导入失败', error.message);
  } finally { importPending = false; }
}
function showImportDiagnostic(diagnostic, title, message) {
  const d = diagnostic || {};
  const display = value => value === null || value === undefined ? '未获取' : JSON.stringify(value);
  const segments = d.segments?.length ? d.segments.map(item => '第 ' + item.index + ' 段：' + (item.shots ?? '无 shots 数组') + ' 镜').join('；') : '无';
  const filtered = d.filtered?.length ? d.filtered.join('；') : '无';
  const missing = d.missing?.length ? d.missing.join('；') : '无';
  modal(title + ' · 导入诊断', '<p>' + E(message) + '</p><div class="confirm-list">' +
    '<div>project.json 路径：' + E(d.path || '未找到') + '</div>' +
    '<div>format：' + E(display(d.format)) + '</div><div>version：' + E(display(d.version)) + '</div>' +
    '<div>分段位置：' + E(d.segmentPath || '未获取') + '</div><div>segments 原始数量：' + E(display(d.rawSegments)) + '</div><div>每段镜数：' + E(segments) + '</div>' +
    '<div>被过滤的段或镜：' + E(filtered) + '</div><div>缺失图片：' + E(missing) + '</div>' +
    (d.library ? '<div>人物库 / 场景库 / 道具库：' + d.library.characters + ' / ' + d.library.scenes + ' / ' + d.library.assets + '</div>' : '') +
    (d.gridPrompts !== undefined && d.gridPrompts !== null ? '<div>带四宫格总提示词的段：' + d.gridPrompts + ' 段</div>' : '') +
    (d.bindings?.length ? '<details><summary>每段绑定</summary>' + d.bindings.map(item => '<div>第 ' + item.index + ' 段 · 人物：' + E(item.characters.join('、') || '无') + '；场景与道具：' + E(item.assets.join('、') || '无') + '</div>').join('') + '</details>' : '') + '</div>',
    button('关闭', 'close', 'class="primary"'));
}
async function act(action, data) {
  const p = project();
  const { seg } = pick();
  switch (action) {
    case 'settings':
      settings();
      if (state.settings.deepSuffix) await refreshModelLists(['deep']);
      break;
    case 'close': close(); break;
    case 'project': current = data.id; selection = 1; render(); break;
    case 'shot': selection = Number(data.shot); render(); break;
    case 'timeline-focus':
      timelineFocus = !timelineFocus;
      render();
      $('.segment.selected')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      break;
    case 'checks': checks(); break;
    case 'fullscreen': await invoke('fullscreen'); break;
    case 'diagnose': {
      const segment = Number($('#analysis-segment').value);
      const withImages = $('#analysis-images').checked;
      const status = $('#modal-status');
      status.textContent = 'DeepSeek 正在分析…';
      const report = await invoke('diagnose', current, segment, withImages, $('#analysis-model').value);
      if ($('#modal-status') === status) diagnosisReview(segment, report);
      break;
    }
    case 'apply-diagnosis': {
      const indices = [...dialog.querySelectorAll('[data-proposal]:checked')].map(item => Number(item.dataset.proposal));
      const remaining = await invoke('apply-diagnosis', current, data.token, indices);
      await refresh(); checks();
      if ($('#modal-status')) $('#modal-status').textContent = '已应用，本段剩余 ' + remaining + ' 项。';
      else notify('已应用，本段剩余 ' + remaining + ' 项。');
      break;
    }
    case 'art-library': artLibrary(); break;
    case 'art-replace':
    case 'art-reset':
      if (await invoke('replace-art', current, data.group, data.asset, action === 'art-reset')) {
        await refresh();
        if (openModal === 'art') artLibrary();
      }
      break;
    case 'locate':
      selection = Number(data.shot) || p.segments.find(item => item.index === Number(data.segment)).shots[0].shotIndex;
      close(); render();
      $('.segment.selected').scrollIntoView({ block: 'nearest', inline: 'nearest' });
      break;
    case 'import': await importZip(); break;
    case 'remove': if (await invoke('remove', current)) { current = ''; await refresh(); } break;
    case 'cleanup-versions': {
      const result = await invoke('cleanup-versions', current);
      await refresh();
      notify(result.removed ? '已清理 ' + result.removed + ' 个旧版。' : '没有旧版可清理。');
      break;
    }
    case 'queue-all': await confirmQueue(); break;
    case 'queue-one': await confirmQueue(seg.index); break;
    case 'part-check':
    case 'sample-check': {
      const segment = p.segments.find(item => item.parts.some(part => part.id === data.part));
      await confirmQueue(segment.index, data.part, action === 'sample-check' ? 'sample' : 'normal');
      break;
    }
    case 'sample-now':
      $('#modal-status').textContent = '正在加入队列…';
      await invoke('sample', current, Number(data.segment), data.part);
      close(); await refresh(); notify('480P 小样已加入队列。');
      break;
    case 'redo-check': await confirmQueue(p.jobs[data.part].segment, data.part, 'redo'); break;
    case 'redo-now': await invoke('redo', current, data.part); close(); await refresh(); break;
    case 'versions': versions(data.part); break;
    case 'select-version': await invoke('select-clip', current, data.part, data.version); close(); await refresh(); notify('已选用该版本，可重新拼接。'); break;
    case 'review': reviewEpisode(); break;
    case 'mix-settings': mixSettings(); break;
    case 'save-mix': {
      const mix = Object.fromEntries(['subtitles', 'nativeAudio', 'effects'].map(key => [key, $('#mix-' + key).checked]));
      await invoke('mix', current, { ...mix, musicVolume: $('#mix-volume').valueAsNumber });
      close(); await refresh(); break;
    }
    case 'start': {
      const count = await invoke('queue', current, Number(data.segment) || undefined, data.part || undefined);
      close(); await refresh(); notify(count ? '已将 ' + count + ' 个子段加入队列。' : '正在处理已有子段。');
      break;
    }
    case 'prompt': prompts(); break;
    case 'shot-edit': shotEditor(); break;
    case 'binding-edit': bindingEditor(); break;
    case 'binding-reset':
    case 'binding-save': {
      const changes = {};
      for (const group of ['characters', 'scenes', 'props']) {
        const options = [...dialog.querySelectorAll('[data-binding="' + group + '"]')];
        if (options.some(option => option.checked !== option.defaultChecked)) {
          changes[group] = options.filter(option => option.checked).map(option => option.value);
        }
      }
      await invoke('edit-bindings', current, seg.index, action === 'binding-reset' ? null : changes);
      close(); await refresh(); notify('分段绑定已更新。'); break;
    }
    case 'shot-reset':
    case 'shot-save': {
      const { shot } = pick();
      const input = action === 'shot-reset' ? null : Object.fromEntries(shotFields.map(([key]) => [key, $('#shot-' + key).value]));
      await invoke('edit-shot', current, seg.index, shot.shotIndex, input);
      close(); await refresh(); notify('分镜已更新。'); break;
    }
    case 'save-settings': {
      const newDeepKey = Boolean($('#deep').value.trim());
      await saveSettings();
      if (newDeepKey) await refreshModelLists(['deep']);
      else { close(); await refresh(); notify('设置已保存。'); }
      break;
    }
    case 'refresh-models': {
      await saveSettings();
      await refreshModelLists();
      break;
    }
    case 'key-link': await invoke('key-link', data.kind); break;
    case 'test': {
      await saveSettings();
      $('#modal-status').textContent = '正在测试…';
      const result = await invoke('test', data.kind);
      if (openModal === 'settings') $('#modal-status').textContent = result;
      break;
    }
    case 'resume': await saveSettings(); await invoke('resume'); close(); await refresh(); notify('队列已恢复。'); break;
    case 'retry': retry(data.part); break;
    case 'retry-now':
    case 'retry-remote': {
      const remote = action === 'retry-remote' ? $('#remote-id').value.trim() : '';
      if (action === 'retry-remote' && !remote) throw Error('请输入 MiniMax 任务 ID。');
      $('#modal-status').textContent = '正在恢复任务…';
      await invoke('retry', current, data.part, remote);
      close(); await refresh(); notify('任务已恢复，可在生成队列查看进度。');
      break;
    }
    case 'clip':
    case 'clip-original': {
      const sample = data.part.startsWith('sample-');
      const attrs = 'data-part="' + E(data.part) + '"';
      const hd = p.jobs[data.part]?.activeHD;
      const original = action === 'clip-original';
      const item = data.part + (original ? ':original' : '');
      modal((sample ? '小样 ' + data.part.slice(7) : '子段 ' + data.part) +
        (hd ? original ? ' · 原版' : ' · 高清 ' + hd.width + ' × ' + hd.height : ''),
        '<video class="modal-video" controls preload="metadata" src="' + url('clip', current, item) + '"></video>',
        (hd ? button(original ? '看高清版' : '看原版', original ? 'clip' : 'clip-original', attrs) : '') +
        button(hd ? '重新转高清' : sample ? '小样转高清' : '本地转高清', 'hd-check', attrs) +
        button('保存' + (hd && !original ? '高清' : '') + ' MP4', 'save-clip', 'class="primary" data-part="' + E(item) + '"'));
      break;
    }
    case 'hd-check': {
      const sample = data.part?.startsWith('sample-');
      const source = sample ? '小样' : data.part ? '正式版' : '整集成片';
      const part = sample ? data.part.slice(7) : data.part;
      const attrs = part ? ' data-part="' + E(data.part) + '"' : '';
      const redo = Boolean(part && p.jobs[data.part]?.activeHD);
      modal(part ? source + (redo ? '重新转高清 · ' : '转高清 · ') + part : '本地转高清',
        '<p>SeedVR2 3B 在本机使用显卡增强连续帧，8GB 显存模式可能较慢。FFmpeg 常规放大更快。</p>' +
        '<p class="muted">两种方式均保留画幅与原音轨。' +
        (part ? '点击后直接从原版处理。成功后自动采用新高清版，可在预览窗口另存。' : '结果另存为 MP4。') +
        '</p><p id="hd-stage" role="status"></p>',
        (part ? button('采用已有高清 MP4', 'adopt-hd', attrs) : '') +
        button(redo ? '用 FFmpeg 重转' : 'FFmpeg 常规放大', 'save-hd', attrs) +
        button(redo ? '用 SeedVR2 3B 重转' : 'SeedVR2 3B · AI 转高清', 'save-hd', 'class="primary" data-method="seedvr2"' + attrs));
      break;
    }
    case 'save-hd': {
      const status = $('#hd-stage');
      status.className = 'green';
      status.textContent = data.part ? '已启动本地处理，正在读取原版视频…' : '选择保存位置后将在本机处理…';
      const controls = [...dialog.querySelectorAll('[data-action="save-hd"], [data-action="adopt-hd"]')];
      controls.forEach(control => { control.disabled = true; });
      const off = window.studio.onHdProgress ? window.studio.onHdProgress(progress => {
        if (dialog.open && $('#hd-stage') === status) status.textContent = typeof progress === 'number' ?
          '本地转高清处理中 ' + progress + '%…' : progress.stage;
      }) : null;
      try {
        const method = data.method || 'ffmpeg';
        const hd = data.part ? await invoke('enhance-clip', current, data.part, method) :
          await invoke('export', 'hd', current, undefined, method);
        if (hd) {
          if (dialog.open && $('#hd-stage') === status) close();
          await refresh();
          notify((hd.adopted ? '已采用新高清版 · ' : '已保存高清 MP4 · ') + hd.width + ' × ' + hd.height);
        } else if (dialog.open && $('#hd-stage') === status) status.textContent = '';
      } catch (error) {
        if (!dialog.open || $('#hd-stage') !== status) notify(error.message, true);
        else { status.className = 'red'; status.textContent = error.message; }
      } finally {
        if (off) off();
        controls.forEach(control => { control.disabled = false; });
      }
      break;
    }
    case 'adopt-hd': {
      const result = await invoke('adopt-hd', current, data.part);
      if (result) { close(); await refresh(); notify('已采用高清 · ' + result.width + ' × ' + result.height); }
      break;
    }
    case 'save-clip':
    case 'save-episode':
      if (await invoke('export', action === 'save-clip' ? 'clip' : 'episode', current, data.part)) notify('MP4 已保存。');
      break;
    case 'music': await invoke('music', current, false); await refresh(); if (openModal === 'mix') mixSettings(); break;
    case 'music-clear': await invoke('music', current, true); await refresh(); if (openModal === 'mix') mixSettings(); break;
    case 'reassemble': await invoke('reassemble', current); await refresh(); break;
    case 'save-prompt': {
      const values = Object.fromEntries([...dialog.querySelectorAll('[data-edit]')].map(item => [item.dataset.edit, item.value]));
      await invoke('edit', current, seg.index, values, 'manual'); await refresh(); prompts(); break;
    }
    case 'optimize':
      $('#modal-status').textContent = '正在优化画面和运镜…';
      await invoke('edit', current, seg.index, {}, 'deep'); await refresh(); if (openModal === 'prompt') prompts(); break;
    case 'undo': await invoke('undo', current, seg.index); await refresh(); prompts(); break;
  }
}
function fail(error) {
  if (dialog.open && $('#modal-status')) {
    $('#modal-status').textContent = error.message;
    $('#modal-status').classList.add('red');
  } else notify(error.message, true);
}
document.addEventListener('click', event => {
  const target = event.target.closest('button');
  if (!target) return;
  const action = target.dataset.action || (['settings','import'].includes(target.id) ? target.id : '');
  if (!action) return;
  target.disabled = true;
  void act(action, target.dataset).catch(fail).finally(() => { target.disabled = false; });
});
document.addEventListener('dragover', event => { event.preventDefault(); document.body.classList.add('drag'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) document.body.classList.remove('drag'); });
document.addEventListener('drop', event => {
  event.preventDefault();
  document.body.classList.remove('drag');
  if (dialog.open) return;
  const file = event.dataTransfer.files[0];
  if (file) void importZip(window.studio.droppedFile(file)).catch(fail);
});
dialog.addEventListener('close', () => { openModal = ''; });
void refresh().catch(fail);
setInterval(() => void refresh().catch(fail), 1300);

