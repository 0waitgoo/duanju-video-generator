'use strict';
/* 前端：导入 ZIP → 按段列出子段与提示词 → DeepSeek 优化 / 手动改 → MiniMax H3 生成 → 轮询收片。 */
const $ = (s) => document.querySelector(s);
let state = { settings: null, projects: [], activeProjectId: null, jobs: [] };
let project = null;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 4000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ ok: false, error: '服务器返回异常' }));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

function statusText(job) {
  return { queued: '排队中', running: '生成中', done: '已完成', failed: '失败', cancelled: '已取消' }[job.status] || job.status;
}

async function refreshState() {
  const data = await api('/api/state');
  if (!data.ok) return;
  state = data;
  const s = data.settings;
  const keyEl = $('#keyStatus');
  if (s.minimaxKeySet && s.deepseekKeySet) {
    keyEl.textContent = 'Key 已填 ✓';
    keyEl.classList.add('ok');
  } else if (s.minimaxKeySet) {
    keyEl.textContent = '已填 MiniMax Key，缺 DeepSeek Key';
    keyEl.classList.remove('ok');
  } else {
    keyEl.textContent = '未填 Key';
    keyEl.classList.remove('ok');
  }
  renderJobs(data.jobs);
  if (data.activeProjectId) {
    await loadProject(data.activeProjectId);
  } else {
    $('#projectBox').classList.add('hidden');
    $('#emptyBox').classList.remove('hidden');
  }
}

async function loadProject(id) {
  const data = await api(`/api/project?id=${encodeURIComponent(id)}`);
  if (!data.ok) {
    toast(data.error || '读取项目失败');
    return;
  }
  project = data.project;
  renderProject();
}

function renderProject() {
  const shots = project.segments.reduce((n, s) => n + s.shots.length, 0);
  $('#projectTitle').textContent = `🎬 ${project.canvasName}`;
  $('#projectMeta').textContent =
    `${project.segments.length} 段 · ${shots} 镜 · ${project.imageCount || 0} 张图` +
    (project.missingImages && project.missingImages.length
      ? ` · 缺图 ${project.missingImages.length} 张（${project.missingImages.join('、')}）`
      : '');
  $('#projectBox').classList.remove('hidden');
  $('#emptyBox').classList.add('hidden');
  const box = $('#segments');
  box.innerHTML = '';
  for (const seg of project.segments) {
    const segEl = document.createElement('div');
    segEl.className = 'seg';
    segEl.innerHTML = `<h3>第 ${seg.index} 段 <span class="muted small">${seg.title || ''} · 约 ${seg.totalSeconds} 秒</span></h3>
      <div class="muted small">${seg.gridImage ? '四宫格图：' + seg.gridImage : '无四宫格图'}</div>`;
    for (const part of seg.parts) {
      const partEl = document.createElement('div');
      partEl.className = 'part';
      const badge =
        part.promptSource === 'deepseek'
          ? '<span class="badge deepseek">DeepSeek 已优化</span>'
          : part.promptSource === 'manual'
            ? '<span class="badge manual">手动编辑</span>'
            : '<span class="badge">拼装稿</span>';
      const chips = [
        ...part.characters.map((c) => `<span class="chip">${c.name}</span>`),
        ...part.assets.map((a) => `<span class="chip asset">${a.kind}·${a.name}</span>`),
      ].join('');
      const job = state.jobs.find(
        (j) => j.segmentIndex === seg.index && j.partIndex === part.partIndex && j.projectId === project.id,
      );
      partEl.innerHTML = `
        <div class="part-head">
          <strong>${part.partsCount > 1 ? `第 ${part.partIndex + 1} 部分／共 ${part.partsCount} 部分` : '整段'} · ${part.shotIndexes.map((i) => '分镜' + i).join('、')} · 约 ${part.seconds} 秒</strong>
          ${badge}
        </div>
        <div class="chips">${chips || '<span class="muted small">无绑定</span>'}</div>
        <pre class="prompt" id="prompt-${seg.index}-${part.partIndex}"></pre>
        <div class="row">
          <button class="btn" data-act="optimize" data-seg="${seg.index}" data-part="${part.partIndex}">✨ DeepSeek 优化提示词</button>
          <button class="btn" data-act="edit" data-seg="${seg.index}" data-part="${part.partIndex}">✏️ 编辑提示词</button>
          <button class="btn primary" data-act="generate" data-seg="${seg.index}" data-part="${part.partIndex}">🎬 生成视频</button>
          <span class="muted small" id="jobline-${seg.index}-${part.partIndex}">${job ? `任务：${statusText(job)}${job.error ? ' — ' + job.error : ''}` : ''}</span>
        </div>
        <div id="video-${seg.index}-${part.partIndex}"></div>`;
      partEl.querySelector(`#prompt-${seg.index}-${part.partIndex}`).textContent = part.prompt;
      const videoBox = partEl.querySelector(`#video-${seg.index}-${part.partIndex}`);
      if (job && job.status === 'done' && job.videoFile) {
        videoBox.innerHTML = `<video controls src="/api/jobs/${job.id}/video"></video>
          <div class="row"><a class="btn" href="/api/jobs/${job.id}/download">⬇️ 下载成片</a></div>`;
      }
      segEl.appendChild(partEl);
    }
    box.appendChild(segEl);
  }
}

function renderJobs(jobs) {
  const box = $('#jobsBox');
  if (!jobs || jobs.length === 0) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  $('#jobs').innerHTML = jobs
    .map(
      (j) => `<div class="job">
        <div><strong>第 ${j.segmentIndex} 段 · 第 ${j.partIndex + 1} 部分</strong>
        （${j.shotIndexes.map((i) => '分镜' + i).join('、')}，${j.seconds} 秒 → 生成 ${j.duration} 秒）
        <span class="st ${j.status}">${statusText(j)}</span></div>
        <div class="muted small">参考图 ${j.refCount} 张（${(j.refLabels || []).join('、')}）· 提示词：${j.promptSource === 'deepseek' ? 'DeepSeek 优化' : j.promptSource === 'manual' ? '手动编辑' : '拼装稿'} · ${new Date(j.createdAt).toLocaleString()}</div>
        ${j.error ? `<div class="muted small" style="color:#ff9b9b">错误：${j.error}</div>` : ''}
        ${j.status === 'done' ? `<video controls src="/api/jobs/${j.id}/video"></video><div class="row"><a class="btn" href="/api/jobs/${j.id}/download">⬇️ 下载成片</a></div>` : ''}
        ${j.status === 'queued' || j.status === 'running' ? `<div class="row"><button class="btn danger" data-cancel="${j.id}">取消</button></div>` : ''}
      </div>`,
    )
    .join('');
}

async function importFile(file) {
  $('#importMsg').textContent = '导入中…';
  try {
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    const data = await res.json();
    if (!data.ok) {
      $('#importMsg').textContent = '导入失败：' + (data.error || '未知错误');
      return;
    }
    $('#importMsg').textContent = `导入成功：${data.project.canvasName}，${data.project.segments} 段 ${data.project.shots} 镜，${data.project.imageCount} 张图` +
      (data.project.missingImages.length ? `（缺图 ${data.project.missingImages.length} 张）` : '');
    await refreshState();
  } catch (e) {
    $('#importMsg').textContent = '导入失败：' + e.message;
  }
}

function openSettings() {
  const s = state.settings || {};
  $('#deepseekMasked').textContent = s.deepseekKeySet ? '已保存（末 4 位 ' + s.deepseekKeyMasked + '）' : '未填写';
  $('#minimaxMasked').textContent = s.minimaxKeySet ? '已保存（末 4 位 ' + s.minimaxKeyMasked + '）' : '未填写';
  $('#deepseekKey').value = '';
  $('#minimaxKey').value = '';
  $('#minimaxBaseUrl').value = s.minimaxBaseUrl || 'https://api.minimax.io';
  $('#model').value = s.model || 'MiniMax-H3';
  $('#resolution').value = s.resolution || '768P';
  $('#ratio').value = s.ratio || 'adaptive';
  $('#generateAudio').value = String(s.generateAudio !== false);
  $('#testConnMsg').textContent = '';
  $('#settingsModal').classList.remove('hidden');
}

async function saveSettings() {
  const body = {
    minimaxBaseUrl: $('#minimaxBaseUrl').value,
    model: $('#model').value,
    resolution: $('#resolution').value,
    ratio: $('#ratio').value,
    generateAudio: $('#generateAudio').value === 'true',
  };
  if ($('#deepseekKey').value) body.deepseekKey = $('#deepseekKey').value;
  if ($('#minimaxKey').value) body.minimaxKey = $('#minimaxKey').value;
  const data = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!data.ok) return toast(data.error || '保存失败');
  toast('设置已保存（Key 只存本机）');
  $('#settingsModal').classList.add('hidden');
  await refreshState();
}

async function testConnections() {
  $('#testConnMsg').textContent = '测试中…';
  const data = await api('/api/test-connections', { method: 'POST' });
  if (!data.ok) return ($('#testConnMsg').textContent = '测试失败：' + (data.error || ''));
  $('#testConnMsg').textContent =
    `DeepSeek：${data.deepseek.ok ? '✓' : '✗'} ${data.deepseek.message} ｜ MiniMax：${data.minimax.ok ? '✓' : '✗'} ${data.minimax.message}`;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const seg = Number(btn.dataset.seg);
    const part = Number(btn.dataset.part);
    if (btn.dataset.act === 'optimize') {
      btn.disabled = true;
      btn.textContent = '优化中…';
      const data = await api(`/api/segments/${seg}/parts/${part}/optimize`, { method: 'POST' });
      if (data.ok) {
        toast('DeepSeek 优化完成（台词逐字未动）');
        await loadProject(project.id);
      } else {
        toast('优化失败：' + (data.error || '未知错误') + '（提示词未改动）');
      }
      btn.disabled = false;
      btn.textContent = '✨ DeepSeek 优化提示词';
    }
    if (btn.dataset.act === 'edit') {
      const pre = document.querySelector(`#prompt-${seg}-${part}`);
      if (pre.tagName === 'TEXTAREA') return;
      const ta = document.createElement('textarea');
      ta.className = 'prompt editing';
      ta.id = pre.id;
      ta.value = pre.textContent;
      pre.replaceWith(ta);
      btn.textContent = '💾 保存提示词';
      btn.dataset.act = 'save';
    }
    if (btn.dataset.act === 'save') {
      const ta = document.querySelector(`#prompt-${seg}-${part}`);
      const data = await api(`/api/segments/${seg}/parts/${part}/prompt`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ta.value }),
      });
      if (!data.ok) return toast(data.error || '保存失败');
      toast('提示词已保存（手动编辑）');
      await loadProject(project.id);
    }
    if (btn.dataset.act === 'generate') {
      if (!state.settings || !state.settings.minimaxKeySet) {
        toast('请先在设置里填写 MiniMax Key');
        openSettings();
        return;
      }
      btn.disabled = true;
      btn.textContent = '提交中…';
      const data = await api('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: project.id, segmentIndex: seg, partIndex: part }),
      });
      if (!data.ok && !data.job) toast('提交失败：' + (data.error || '未知错误'));
      if (data.job) toast(data.ok ? '已提交 MiniMax，生成中…' : '提交失败：' + (data.error || ''));
      btn.disabled = false;
      btn.textContent = '🎬 生成视频';
      await refreshState();
    }
    return;
  }
  const cancelBtn = e.target.closest('[data-cancel]');
  if (cancelBtn) {
    await api(`/api/jobs/${cancelBtn.dataset.cancel}/cancel`, { method: 'POST' });
    await refreshState();
  }
});

$('#pickFileBtn').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) importFile(e.target.files[0]);
  e.target.value = '';
});
const dz = $('#importBox');
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) importFile(f);
});
$('#settingsBtn').addEventListener('click', openSettings);
$('#settingsCancelBtn').addEventListener('click', () => $('#settingsModal').classList.add('hidden'));
$('#settingsSaveBtn').addEventListener('click', saveSettings);
$('#testConnBtn').addEventListener('click', testConnections);

refreshState();
setInterval(refreshState, 5000);
