'use strict';
const $ = selector => document.querySelector(selector);
const work = $('#workspace');
const dialog = $('#modal');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const E = escapeHtml;
const labels = { queued: '排队中', submitting: '正在提交', remote: '生成中', done: '已完成', failed: '失败', uncertain: '需核对提交' };
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => '%' + char.charCodeAt(0).toString(16));
const url = (kind, id, item = '') => 'studio://' + kind + '/' + encode(id) + '/' + encode(item);
const seconds = value => Number(value.toFixed(2)) + ' 秒';
const money = value => (value / 1024 ** 2).toFixed(1) + ' MB';
const measure = shots => shots.reduce((sum, shot) => sum + shot.durationSec, 0);
let state = { projects: [], settings: {} };
let current = '';
let selection = 1;
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
  const markup = state.projects.map(p => button('<strong>' + E(p.canvasName) + '</strong><span>' +
    p.segments.length + ' 段 · ' + p.segments.reduce((sum, s) => sum + s.shots.length, 0) + ' 镜</span>',
  'project', 'class="project-button ' + (p.id === current ? 'active' : '') + '" data-id="' + E(p.id) + '"')).join('');
  if ($('#projects').innerHTML !== markup) $('#projects').innerHTML = markup;
}
function segmentTile(p, seg, active) {
  const states = seg.parts.map(part => p.jobs[part.id]?.status);
  const status = seg.problem ? '需调整时长' : states.every(item => item === 'done') ? '已完成' :
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
    '</div><span class="seg-state">' + status + '</span></article>';
}
function tags(p, items) {
  return items.map(item => '<span class="tag" title="' + E(item.description) + '">' +
    (p.images[item.image] ? '<img alt="" src="' + url('image', p.id, item.image) + '">' : '') + E(item.name) + '</span>').join('');
}
function inspector(p, seg, shot) {
  if (!shot) return '';
  const dialogue = shot.dialogue?.text?.trim() ? '<p class="dialogue"><small>台词</small>💬 ' +
    E((shot.dialogue.speaker ? shot.dialogue.speaker + '：' : '') + shot.dialogue.text) + '</p>' : '<p class="muted">无台词</p>';
  return '<aside class="panel inspector"><header class="panel-head"><h2>第 ' + shot.shotIndex +
    ' 镜</h2><span class="mono muted">' + E(seconds(shot.durationSec)) + '</span></header><div class="inspect-body">' +
    '<p><small>画面 · ' + E(shot.framing) + '</small>' + E(shot.visual || '—') + '</p>' +
    '<p><small>分镜提示词</small>' + E(shot.prompt || '—') + '</p>' + dialogue +
    '<p><small>运镜</small>' + E(shot.camera || '—') + '</p><p><small>音效</small>' + E(shot.sfx || '—') + '</p>' +
    '<small>本段人物锁</small><div class="tags">' + (tags(p, seg.bindings.characters) || '—') + '</div>' +
    '<small>本段场景与道具</small><div class="tags">' + (tags(p, seg.bindings.assets) || '—') + '</div>' +
    (seg.gridPrompt ? '<p><small>四宫格总提示词</small>' + E(seg.gridPrompt) + '</p>' : '') + '</div></aside>';
}
function queuePanel(p, allParts) {
  const rows = allParts.map(part => {
    const job = p.jobs[part.id];
    const stateClass = ['failed', 'uncertain'].includes(job?.status) ? 'red' : job?.status === 'done' ? 'green' : 'muted';
    const status = labels[job?.status] || '未提交';
    const controls = job?.status === 'done'
      ? button('预览', 'clip', 'data-part="' + part.id + '"') + button('保存', 'save-clip', 'data-part="' + part.id + '"')
      : ['failed', 'uncertain'].includes(job?.status) ? button(job.status === 'uncertain' ? '核对' : '重试', 'retry', 'data-part="' + part.id + '"') : '';
    const detail = '#' + part.shots.map(shot => shot.shotIndex).join('、#') + ' · ' + part.duration + ' 秒' +
      (job ? ' · ' + job.settings.resolution + (job.attempts.length ? ' · 已提交 ' + job.attempts.length + ' 次' : '') : '');
    return '<div class="queue-row"><div><b>子段 ' + part.id + '</b><div class="' + stateClass + '">' + status +
      '</div></div><div class="detail muted">' + E(detail) +
      (job?.error ? '<div class="red">' + E(job.error.message + (job.error.code ? '（' + job.error.code + '）' : '')) + '</div>' : '') +
      '</div><div class="controls">' + controls + '</div></div>';
  }).join('');
  const done = allParts.filter(part => p.jobs[part.id]?.status === 'done').length;
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
    button('保存整集 MP4', 'save-episode', 'class="primary"');
  const canRebuild = allParts.length > 0 && !p.segments.some(seg => seg.problem) && allParts.every(part => p.jobs[part.id]?.status === 'done') && result.status !== 'rendering';
  return '<section class="panel"><header class="panel-head"><h2>整集成片</h2><span class="mono muted">MP4</span></header><div class="result">' +
    content + '<p class="muted">' + (p.music ? '配乐 · ' + E(p.music) : '配乐 · 关闭') + '</p><div class="small-buttons">' +
    button(p.music ? '更换配乐' : '选择配乐', 'music') + (p.music ? button('关闭配乐', 'music-clear', 'class="subtle"') : '') +
    (canRebuild ? button('重新拼接', 'reassemble') : '') + '</div></div></section>';
}
function render() {
  renderProjects();
  const p = project();
  const key = JSON.stringify([p, selection, state.hold, state.queueError, state.settings.resolution]);
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
  const queueScroll = $('.queue-scroll')?.scrollTop || 0;
  const inspectScroll = $('.inspect-body')?.scrollTop || 0;
  const existingVideo = $('#episode-player');
  const runningText = state.hold || state.queueError;
  const newCount = allParts.filter(part => !p.jobs[part.id]).length;
  const generateLabel = p.episode.status === 'done' ? '整集已生成' : '一键生成整集';
  work.innerHTML = '<div class="content"><header class="overview"><div><h1>' + E(p.title) +
    '</h1><div class="canvas">' + E(p.canvasName) + '</div></div><div class="actions">' +
    button('删除', 'remove', 'class="subtle"') + button(generateLabel, 'queue-all', 'class="primary" ' + (p.episode.status === 'done' ? 'disabled' : '')) +
    '</div></header><div class="facts"><span><b>' + p.segments.length + '</b>段</span><span><b>' +
    p.segments.reduce((sum, item) => sum + item.shots.length, 0) + '</b>镜</span><span><b>' + E(seconds(measure(p.segments.flatMap(item => item.shots)))) +
    '</b>总长</span><span><b>' + Object.keys(p.images).length + '</b>张图</span><span><b>' + newCount +
    '</b>个待提交子段</span><div class="checks">' + button(loneRed ? loneRed + ' 项问题' : loneYellow ? loneYellow + ' 项提醒' : '一致性通过', 'checks',
    'class="check-button ' + (loneRed ? 'red' : loneYellow ? 'yellow' : 'green') + '"') + '</div></div>' +
    (runningText ? '<p class="notice">' + E(runningText) + ' ' + button('打开设置', 'settings', 'class="quiet"') + '</p>' : '') +
    '<div class="editing"><section class="panel"><header class="panel-head"><h2>分镜时间线</h2><div class="panel-tools">' +
    button('提示词工作台', 'prompt') + button('生成本段', 'queue-one') +
    '</div></header><div class="timeline">' + p.segments.map(segment => segmentTile(p, segment, seg.index)).join('') +
    '</div></section>' + inspector(p, seg, shot) + '</div><div class="lower">' + queuePanel(p, allParts) + resultPanel(p, allParts) + '</div></div>';
  $('.timeline').scrollLeft = timelineScroll;
  $('.queue-scroll').scrollTop = queueScroll;
  if ($('.inspect-body')) $('.inspect-body').scrollTop = inspectScroll;
  if (existingVideo && $('#episode-player')?.src === existingVideo.src) $('#episode-player').replaceWith(existingVideo);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    state = await invoke('state');
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
  return '<div class="key-section"><h3>' + E(title) + ' Key <span class="muted">' + (suffix ? ' · ••••' + E(suffix) : ' · 未设置') +
    '</span></h3><div class="key-line"><input id="' + id + '" type="password" placeholder="填写新 Key" aria-label="' + E(title) +
    ' Key" autocomplete="off"><label><input id="' + id + '-clear" type="checkbox"> 清除</label>' +
    button('测试连接', 'test', 'data-kind="' + id + '"') + '</div><p>' + E(text) + ' ' +
    button('申请 Key', 'key-link', 'class="link" data-kind="' + id + '"') + '</p></div>';
}
function settings() {
  const s = state.settings;
  const sets = [keyField('mini', 'MiniMax', s.miniSuffix, 'H3 需要按量付费 Key。'),
    keyField('deep', 'DeepSeek', s.deepSuffix, '用于提示词优化。')];
  modal('设置', sets.join('') + '<div class="settings-grid">' +
    fieldSelect('site', 'MiniMax 站点', [['https://api.minimax.io','国际站'], ['https://api.minimax.cn','大陆站']], s.base) +
    fieldSelect('resolution', '视频分辨率', [['768P','768P'],['2K','2K']], s.resolution) +
    fieldSelect('ratio', '画幅', [['9:16','9:16 竖屏'],['16:9','16:9 横屏'],['1:1','1:1 方形'],['adaptive','跟随参考图']], s.ratio) +
    fieldSelect('transition', '子段衔接', [['dissolve','短叠化 · 0.2 秒'],['cut','直接切换']], s.transition) +
    fieldSelect('deep-model', 'DeepSeek 优化模型', [['deepseek-chat','deepseek-chat · 交接规范'],['deepseek-flash','deepseek-flash · 现行模型']], s.deepModel) +
    '<label class="field">同时生成子段数<input id="concurrency" type="number" min="1" max="6" value="' + s.concurrency + '"></label></div>' +
    '<p class="muted">DeepSeek 已公告停用 deepseek-chat。可切换现行模型，或使用原始提示词。</p>' +
    '<label class="switch"><input id="h3-audio" type="checkbox" ' + (s.generateAudio ? 'checked' : '') + '> 保留 MiniMax 原生声音</label>' +
    '<label class="switch"><input id="fx" type="checkbox" ' + (s.effects ? 'checked' : '') + '> 自动混入分镜音效</label>',
    (state.hold ? button('恢复队列', 'resume') : '') + button('保存设置', 'save-settings', 'class="primary"'), 'settings');
}
function settingsInput() {
  return {
    mini: $('#mini').value, deep: $('#deep').value, miniClear: $('#mini-clear').checked, deepClear: $('#deep-clear').checked,
    base: $('#site').value, resolution: $('#resolution').value, ratio: $('#ratio').value, transition: $('#transition').value,
    deepModel: $('#deep-model').value, concurrency: $('#concurrency').valueAsNumber,
    generateAudio: $('#h3-audio').checked, effects: $('#fx').checked,
  };
}
async function saveSettings() {
  await invoke('settings', settingsInput());
  $('#mini').value = '';
  $('#deep').value = '';
  $('#mini-clear').checked = false;
  $('#deep-clear').checked = false;
  await refresh();
}
function checks() {
  const p = project();
  const issues = [...p.check.issues].sort((a, b) => a.level.localeCompare(b.level));
  const issue = issues.map(item => button('<span class="' + item.level + '">' + (item.level === 'red' ? '问题' : '提醒') +
    '</span> · 第 ' + item.segment + ' 段' + (item.shot ? ' / 第 ' + item.shot + ' 镜' : '') + ' · ' + E(item.message),
  'locate', 'class="issue" data-segment="' + item.segment + '" data-shot="' + (item.shot || '') + '"')).join('');
  const missing = p.check.missing.length ? '<details><summary>缺失图片清单</summary><ul>' +
    p.check.missing.map(file => '<li>' + E(file) + '</li>').join('') + '</ul></details>' : '';
  modal('一致性检查', (issue || '<p class="green">全部通过。</p>') + missing);
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
function confirmQueue(segment) {
  const p = project();
  const list = segment ? [p.segments.find(item => item.index === segment)] : p.segments;
  const bad = list.find(item => item.problem);
  if (bad) throw Error(bad.problem);
  const queued = list.flatMap(item => item.parts).filter(part => !p.jobs[part.id]);
  const duration = queued.reduce((sum, part) => sum + part.duration, 0);
  const missing = [['miniSuffix', 'MiniMax'], ['deepSuffix', 'DeepSeek']].filter(([field]) => !state.settings[field]).map(([, label]) => label);
  if (missing.length) {
    modal('请先填写 Key', '<p>缺少 ' + E(missing.join('、')) + ' Key。请在设置填入后再生成。</p>', button('打开设置', 'settings', 'class="primary"'));
    return;
  }
  modal(segment ? '生成第 ' + segment + ' 段' : '一键生成整集', '<p>' +
    (queued.length ? '即将向 MiniMax 提交 ' + queued.length + ' 个子段。' : '已有的子段会继续处理或复用。') + '</p>' +
    '<div class="confirm-list"><div>本次提交总时长 · ' + duration + ' 秒</div><div>分辨率 · ' + E(state.settings.resolution) + ' · ' +
    E(state.settings.ratio) + '</div>' + (queued.length ? '<div>按 MiniMax 账户当前资费扣费，部分参考图也可能计费。</div>' : '') +
    (segment ? '' : '<div>全部完成后自动拼接、烧录字幕并混音。</div>') + '</div>',
    button('取消', 'close') + button('确认生成', 'start', 'class="primary" data-segment="' + (segment || '') + '"'));
}
function retry(part) {
  const job = project().jobs[part];
  const uncertain = job.status === 'uncertain';
  modal(uncertain ? '核对 MiniMax 任务' : '重试子段 ' + part, '<p>' + E(job.error?.message) + '</p>' +
    (uncertain ? '<p class="notice">如 MiniMax 已接收，请填写远端任务 ID。确认没有原任务后，才重新提交。</p><label class="field">已有远端任务 ID<input id="remote-id"></label>' :
      '<p class="muted">' + (job.resumeRemote ? '继续查询或下载原任务。' : '重新提交会按服务商资费计费。') + '</p>'),
    button('取消', 'close') + (uncertain ? button('恢复已有任务', 'retry-remote', 'data-part="' + part + '"') : '') +
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
    showImportDiagnostic(project()?.diagnostic, '导入成功', result.replaced ? '已替换同一画布项目。' : '画布项目已导入。');
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
    case 'settings': settings(); break;
    case 'close': close(); break;
    case 'project': current = data.id; selection = 1; render(); break;
    case 'shot': selection = Number(data.shot); render(); break;
    case 'checks': checks(); break;
    case 'locate':
      selection = Number(data.shot) || p.segments.find(item => item.index === Number(data.segment)).shots[0].shotIndex;
      close(); render();
      $('.segment.selected').scrollIntoView({ block: 'nearest', inline: 'nearest' });
      break;
    case 'import': await importZip(); break;
    case 'remove': if (await invoke('remove', current)) { current = ''; await refresh(); } break;
    case 'queue-all': confirmQueue(); break;
    case 'queue-one': confirmQueue(seg.index); break;
    case 'start': {
      const count = await invoke('queue', current, Number(data.segment) || undefined);
      close(); await refresh(); notify(count ? '已将 ' + count + ' 个子段加入队列。' : '正在处理已有子段。');
      break;
    }
    case 'prompt': prompts(); break;
    case 'save-settings': await saveSettings(); close(); notify('设置已保存。'); break;
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
      await invoke('retry', current, data.part, remote); close(); await refresh(); break;
    }
    case 'clip':
      modal('子段 ' + data.part, '<video class="modal-video" controls preload="metadata" src="' + url('clip', current, data.part) + '"></video>',
        button('保存子段 MP4', 'save-clip', 'class="primary" data-part="' + data.part + '"'));
      break;
    case 'save-clip':
    case 'save-episode':
      if (await invoke('export', action === 'save-clip' ? 'clip' : 'episode', current, data.part)) notify('MP4 已保存。');
      break;
    case 'music': await invoke('music', current, false); await refresh(); break;
    case 'music-clear': await invoke('music', current, true); await refresh(); break;
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

