'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { parse } = require('csv-parse/sync');
const fixtures = process.env.DUANJU_HANDOFF;
const ffmpeg = path.join(__dirname, '..', 'build', 'runtime', 'ffmpeg.exe');
const projectIO = require('../src/project');
const provider = require('../src/providers');
const { Workspace } = require('../src/workspace');
const { probe, subtitleFile, upscaleVideo } = require('../src/render');
const run = promisify(execFile);
const fixture = path.join(fixtures || '', '示例包', 'test-package.zip');
test('本地高清导出保留音轨、时长与竖屏比例', async t => {
  const root = await temp(t);
  const source = path.join(root, 'source.mp4');
  const dest = path.join(root, '高清.mp4');
  await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=180x320:r=24',
    '-f', 'lavfi', '-i', 'sine=f=440', '-t', '0.5', '-c:v', 'libx264', '-c:a', 'aac', source]);
  const result = await upscaleVideo(ffmpeg, source, dest);
  assert.deepEqual([result.width, result.height, result.audio], [1080, 1920, true]);
  assert.ok(Math.abs(result.duration - (await probe(ffmpeg, source, root)).duration) < 0.05);
  await assert.rejects(upscaleVideo(ffmpeg, source, source), /不同的输出文件/);
});
const cryptoDouble = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(value, 'utf8').reverse(),
  decryptString: value => Buffer.from(value).reverse().toString('utf8'),
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function temp(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duanju-studio-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('已采用的高清片段在重启后用于预览、生成检查与拼接，原版可单独打开', { skip: !fixtures }, async t => {
  const root = await temp(t);
  let assembledFile;
  const options = { root, secureStorage: cryptoDouble, ffmpeg, assembler: async ({ clips }) => {
    assembledFile = clips[0].file;
    return { width: 1080, height: 1920 };
  } };
  let work = new Workspace(options);
  const { id } = await work.import(fixture);
  const project = work.project(id);
  work.setSettings({ mini: 'fake-mini' });
  work.tick = () => {};
  work.queue(id, 1, '1-1');
  const job = project.jobs['1-1'];
  const dir = path.join(work.downloads, id);
  await fs.mkdir(dir, { recursive: true });
  const original = path.join(dir, 'original.mp4');
  const hd = path.join(root, 'hd.mp4');
  await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=180x320:r=24',
    '-t', '0.5', '-c:v', 'libx264', original]);
  await upscaleVideo(ffmpeg, original, hd);
  Object.assign(job, { file: 'original.mp4', status: 'done' });
  await work.adoptHD(id, '1-1', hd, 'ffmpeg', job.localId);
  await fs.unlink(hd);
  work = new Workspace(options);
  assert.equal(work.pathFor('clip', id, '1-1:original'), original);
  const selected = work.pathFor('clip', id, '1-1');
  assert.notEqual(selected, original);
  assert.equal(work.preflight(id).reusedClips[0].hd.width, 1080);
  await work.render(work.project(id), work.plans(project, 1).slice(0, 1));
  assert.equal(assembledFile, selected);
  await fs.unlink(selected);
  assert.equal(work.pathFor('clip', id, '1-1'), original);
  assert.equal(work.preflight(id).reusedClips[0].hd, null);
});
async function until(work, check) {
  for (let i = 0; i < 350; i++) {
    work.tick();
    if (check()) return;
    await delay(30);
  }
  throw Error('队列未达到预期状态：' + JSON.stringify(work.data.projects.map(p => ({
    jobs: Object.values(p.jobs).map(job => [job.id, job.status, job.error]), episode: p.episode,
  }))));
}
function keys(work) { work.setSettings({ mini: 'fake-mini-secret', deep: 'fake-deep-secret' }); }

test('仅接受画布 v1；镜号连续；不生成单镜或超时子段', () => {
  assert.throws(() => projectIO.normalize({ format: 'other', version: 1 }), /不是画布/);
  assert.throws(() => projectIO.normalize({ format: 'duanju-canvas-export', version: 2 }), /版本不支持/);
  assert.throws(() => projectIO.plan({ index: 1, shots: [{ durationSec: 2 }] }), /只有一镜/);
  assert.throws(() => projectIO.plan({ index: 1, shots: [9, 8, 1, 1].map(durationSec => ({ durationSec })) }), /无法同时满足/);
  assert.equal(projectIO.plan({ index: 1, shots: [{ durationSec: 1 }, { durationSec: 2 }] })[0].duration, 4);
  assert.equal(Boolean(projectIO.safeImage('images/../hidden.png')), false);
  assert.equal(Boolean(projectIO.safeImage('images/x.png:stream.jpg')), false);
  assert.equal(Boolean(projectIO.safeImage('images/角色/正面.png')), true);
});

test('真实交接 ZIP：2 段 8 镜、逐字提示词、稳定格位与按需参考图', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const project = await projectIO.readProjectZip(fixture, root);
  assert.equal(project.segments.length, 2);
  assert.equal(project.segments.flatMap(segment => segment.shots).length, 8);
  assert.equal(Object.keys(project.images).length, 6);
  assert.equal(project.check.missing.length, 0);
  assert.equal(project.check.issues.filter(issue => issue.level === 'red').length, 0);
  assert.ok(project.check.issues.some(issue => issue.message.includes('占位图')));
  const p1 = projectIO.plan(project.segments[0]);
  const p2 = projectIO.plan(project.segments[1]);
  assert.deepEqual([...p1, ...p2].map(part => [part.seconds, part.shots.map(s => s.shotIndex)]), [[10,[1,2]], [10,[3,4]], [12,[5,6,7,8]]]);
  const first = projectIO.prompt(project, project.segments[0], p1[0]);
  const second = projectIO.prompt(project, project.segments[0], p1[1]);
  assert.ok(first.includes('左上→分镜1，右上→分镜2') && first.includes('无台词（静默）'));
  assert.ok(first.includes('走位') && !first.includes('道具：自拍杆'));
  for (const token of ['人物：小雅', '场景：涩谷十字路口', '小雅：女声', '左下→分镜3，右下→分镜4',
    '台词「小雅：今天涩谷，人好多。」', '站位：小雅在斑马线中央']) assert.ok(second.includes(token), token);
  assert.ok(!second.includes('阿杰'));
  assert.deepEqual(projectIO.bindings(project, p1[1].shots).characters.map(c => c.name), ['小雅']);
  const body = JSON.parse(await provider.prepare({ resolution: '768P', ratio: '9:16', generateAudio: false },
    second, [path.join(root, project.segments[0].gridImage)], 10));
  assert.equal(body.model, 'MiniMax-H3');
  assert.equal(body.duration, 10);
  assert.equal(body.ratio, '9:16');
  assert.deepEqual(Object.keys(body.content[1].image_url), ['url']);
  assert.match(body.content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(body.content[1].role, 'reference_image');
  assert.ok(!JSON.stringify(body).includes('first_frame'));
  await assert.rejects(provider.prepare({}, second, Array(10).fill('unused'), 10), /1–9/);
});

test('MiniMax 创建失败保留参数错误码和请求 ID', async t => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  const requestId = '021785229015510a2c883cf675b9804d';
  global.fetch = async () => ({
    ok: false, status: 400,
    json: async () => ({ request_id: requestId, error: { message: 'invalid params (2013)' } }),
  });
  await assert.rejects(provider.create({ base: 'https://api.minimax.cn' }, 'fake-key', '{}'), error =>
    error.code === '2013' && error.requestId === requestId && !error.ambiguous);
});

test('真实交接分镜：逐列比对全部 50 镜，计算场次与人物绑定', {
  skip: !fixtures || !existsSync(path.join(fixtures, '分镜', '分镜表-50镜.csv')) ? '缺交接分镜表' : false,
}, async () => {
  const csv = await fs.readFile(path.join(fixtures, '分镜', '分镜表-50镜.csv'), 'utf8');
  const script = await fs.readFile(path.join(fixtures, '剧本', '《末日游戏》第一集v2.md'), 'utf8');
  const scenes = projectIO.readStoryboard(csv);
  assert.equal(scenes.length, 8);
  assert.match(script, /末日游戏/);
  const shots = scenes.flatMap(scene => scene.shots);
  assert.equal(shots.length, 50);
  const rows = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true }).slice(1).filter(row => /^\d+$/.test(row[0]));
  const characters = ['小雅','阿杰','林晓','苏小雨','王桂花','陈建国','黑西装男人','老玩家','白发老头'].map(name => ({ name, id: name }));
  for (const [i, row] of rows.entries()) {
    const [index, duration, framing, visual, dialogue, sfx, camera] = row;
    const shot = shots[i];
    assert.deepEqual([shot.shotIndex, shot.durationSec, shot.framing, shot.visual, shot.line, shot.sfx, shot.camera],
      [Number(index), Number(duration), framing, visual, dialogue, sfx, camera]);
    if (dialogue === '无') assert.equal(shot.dialogue, null);
    else assert.ok(dialogue.endsWith(shot.dialogue.text));
    const expected = characters.filter(item => (visual + (shot.dialogue ? shot.dialogue.speaker + shot.dialogue.text : '')).includes(item.name));
    assert.deepEqual(projectIO.bindings({ characters, scenes: [], assets: [] }, [{ ...shot, charIds: characters.map(item => item.id), assetIds: [] }]).characters, expected);
  }
  assert.deepEqual(projectIO.bindings({ characters, scenes: [], assets: [] }, shots.slice(0, 4).map(shot => ({ ...shot, assetIds: [] }))).characters.map(c => c.name), ['小雅','阿杰','林晓']);
  console.log('真实分镜：' + scenes.map(scene => scene.shots.length).join(' + ') + ' = 50 镜，共 ' + projectIO.seconds(shots) + ' 秒');
});

test('鉴权失败暂停、缺 Key 拦截、单段筛选和重复导入', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const mock = { ...provider, create: async () => { throw Object.assign(Error('鉴权失败'), { status: 401, code: 1004 }); } };
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg, provider: mock });
  const added = await work.import(fixture);
  const { id } = added;
  assert.throws(() => work.queue(id), /缺少 MiniMax Key/);
  work.setSettings({ mini: 'fake-mini-secret', concurrency: 1 });
  assert.equal(work.preflight(id, 2).blockers.length, 0);
  assert.equal(work.preflight(id, 2).ready.length, 1);
  assert.equal(work.snapshot().settings.miniSuffix, 'cret');
  assert.ok(!(await fs.readFile(work.stateFile, 'utf8')).includes('fake-mini-secret'));
  assert.equal(work.queue(id, 2), 1);
  await until(work, () => Boolean(work.data.hold));
  assert.equal(work.project(id).jobs['2-1'].error.code, 1004);
  assert.equal(Object.keys(work.project(id).jobs).length, 1);
  assert.throws(() => work.queue(id), /暂停/);
  const replaced = await work.import(fixture);
  assert.equal(replaced.revision, 2);
  assert.notEqual(replaced.id, id);
  assert.equal(work.data.projects.length, 2);
});

test('独立子段、480P 小样与分镜编辑互不覆盖', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  work.setSettings({ mini: 'fake-mini-secret' });
  work.tick = () => {};
  const { id } = await work.import(fixture);
  const project = work.project(id);
  const shot = project.segments[0].shots[3];
  const original = { ...shot };
  work.editShot(id, 1, shot.shotIndex, { ...shot, visual: '小雅转向镜头', camera: '缓慢推镜' });
  assert.deepEqual(shot.dialogue, original.dialogue);
  assert.equal(shot.durationSec, original.durationSec);
  const preflight = work.preflight(id, 1, '1-2', 'sample');
  assert.deepEqual(preflight.ready.map(item => item.id), ['1-2']);
  assert.equal(preflight.settings.resolution, '480P');
  work.queueSample(id, 1, '1-2');
  assert.deepEqual(Object.keys(project.jobs), ['sample-1-2']);
  const sample = project.jobs['sample-1-2'];
  assert.match(sample.prompt, /小雅转向镜头/);
  assert.equal(sample.settings.resolution, '480P');
  const body = JSON.parse(await provider.prepare(sample.settings, sample.prompt,
    sample.refs.map(ref => path.join(work.projectsDir, id, ref)), sample.duration));
  assert.equal(body.resolution, '480P');
  assert.equal(body.model, 'MiniMax-H3');
  work.editShot(id, 1, shot.shotIndex, null);
  assert.equal(shot.visual, original.visual);
  assert.equal(work.queue(id, 1, '1-2'), 1);
  assert.deepEqual(Object.keys(project.jobs), ['sample-1-2', '1-2']);
  assert.equal(project.jobs['1-2'].settings.resolution, '768P');
  assert.equal(project.autoAssemble, false);
  const settings = work.setSettings({ resolution: '480P' });
  assert.deepEqual(settings.miniVideoOptions[settings.base]['MiniMax-H3'].resolutions, ['480P', '768P', '2K']);
  assert.deepEqual(settings.miniVideoOptions[settings.base]['MiniMax-H3-Max'].resolutions, ['480P', '768P']);
  assert.deepEqual(provider.miniResolutions('MiniMax-H3-MG'), ['768P', '2K']);
  assert.equal(work.queue(id, 2, '2-1'), 1);
  const formal = project.jobs['2-1'];
  assert.equal(formal.settings.resolution, '480P');
  const formalBody = JSON.parse(await provider.prepare(formal.settings, formal.prompt,
    formal.refs.map(ref => path.join(work.projectsDir, id, ref)), formal.duration));
  assert.equal(formalBody.resolution, '480P');
});

test('DeepSeek 诊断只应用勾选项，拒绝过期结果并保留原台词', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const mock = { ...provider, diagnose: async (_key, context, images, model) => {
    assert.equal(context.segment, 1);
    assert.equal(images.length, 0);
    assert.equal(model, 'deepseek-v4-pro');
    return { summary: '测试建议', proposals: [
      { kind: 'shot', reason: '镜头静音', shot: 1, sfx: '无音效', visual: '不允许修改的画面', dialogue: '禁止改写' },
      { kind: 'shot', reason: '越界镜头', shot: 9, sfx: '无音效' },
      { kind: 'shot', reason: '镜头静音', shot: 2, sfx: '无音效' },
    ] };
  } };
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg, provider: mock });
  work.setSettings({ deep: 'fake-deep', deepModel: 'deepseek-v4-pro' });
  const { id } = await work.import(fixture);
  const project = work.project(id);
  const [shot, second] = project.segments[0].shots;
  const original = { ...shot };
  await assert.rejects(work.diagnose(id, 1, true), /支持看图/);
  await assert.rejects(work.diagnose(id, 1, false, 'unknown-model'), /选择模型/);
  const draft = await work.diagnose(id, 1, false);
  assert.equal(draft.model, 'deepseek-v4-pro');
  assert.equal(draft.proposals.length, 2);
  assert.deepEqual(draft.proposals[0].changes.map(change => change.field), ['sfx']);
  work.applyDiagnosis(id, draft.token, [0]);
  assert.equal(shot.sfx, '无音效');
  assert.equal(second.sfx, '');
  assert.equal(shot.visual, original.visual);
  assert.deepEqual(shot.dialogue, original.dialogue);
  assert.throws(() => work.applyDiagnosis(id, draft.token, [1]), /已失效/);
  const next = await work.diagnose(id, 1, false);
  work.editShot(id, 1, 2, { ...second, visual: '新动作' });
  assert.throws(() => work.applyDiagnosis(id, next.token, [0]), /已变化/);
});

test('本地换图更新后续任务，旧引用可读并可恢复原图', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  const { id } = await work.import(fixture);
  const project = work.project(id);
  const segment = project.segments[0], part = projectIO.plan(segment)[0];
  const item = project.characters.find(actor => actor.name === '小雅');
  const original = item.image;
  const before = work.makeJob(project, segment, part, work.settings());
  const replacement = path.join(root, '新定妆照.png');
  await run(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=256x256', '-frames:v', '1', '-threads', '1', replacement]);
  await work.replaceArt(id, 'characters', item.id, replacement);
  assert.notEqual(item.image, original);
  const updated = work.makeJob(project, segment, part, work.settings());
  assert.ok(updated.refs.includes(path.normalize(item.image)));
  assert.ok(before.refs.includes(path.normalize(original)));
  await fs.access(work.pathFor('image', id, original));
  await work.replaceArt(id, 'characters', item.id, null);
  assert.equal(item.image, original);
  assert.deepEqual(work.makeJob(project, segment, part, work.settings()).refs, before.refs);
});

test('手动绑定影响拆分后的提交，清空保持为空，恢复后回到自动推导', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  const { id } = await work.import(fixture);
  const project = work.project(id);
  const segment = project.segments[0];
  const part = projectIO.plan(segment)[1];
  const refs = () => projectIO.referenceFiles(project, segment, part).files;
  const original = refs();
  const actor = project.characters.find(item => !original.includes(item.image));
  const dialogue = structuredClone(part.shots.at(-1).dialogue);
  assert.ok(actor);
  work.editBindings(id, 1, { characters: [actor.id], scenes: [], props: [] });
  assert.deepEqual(refs(), [segment.gridImage, actor.image]);
  assert.ok(projectIO.prompt(project, segment, part).includes('人物参考：' + actor.name));
  assert.deepEqual(part.shots.at(-1).dialogue, dialogue);
  const restarted = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  assert.equal(restarted.snapshot().projects[0].segments[0].bindings.characters[0].id, actor.id);
  assert.throws(() => work.editBindings(id, 1, { props: [actor.id] }), /不在该分类/);
  work.editBindings(id, 1, null);
  assert.deepEqual(refs(), original);
});

test('重做保留旧片，主动选择新片，同一输入才复用', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  work.setSettings({ mini: 'fake-mini-secret' });
  work.tick = () => {};
  const { id } = await work.import(fixture);
  const project = work.project(id);
  work.queue(id, 2);
  const original = project.jobs['2-1'];
  const folder = path.join(work.downloads, id);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'old.mp4'), 'old fixture');
  Object.assign(original, { status: 'done', file: 'old.mp4' });
  work.redo(id, '2-1');
  const next = project.jobs['2-1'];
  assert.notEqual(next.localId, original.localId);
  assert.equal(work.pathFor('clip', id, '2-1'), path.join(folder, 'old.mp4'));
  assert.equal(work.snapshot().projects[0].jobs['2-1'].usable, true);
  await fs.writeFile(path.join(folder, 'new.mp4'), 'new fixture');
  Object.assign(next, { status: 'done', file: 'new.mp4' });
  work.selectClip(id, '2-1', next.localId);
  assert.equal(work.pathFor('clip', id, '2-1'), path.join(folder, 'new.mp4'));
  assert.equal(work.pathFor('clip', id, '2-1:' + original.localId), path.join(folder, 'old.mp4'));
  const newer = await work.import(fixture);
  assert.deepEqual(newer.reused, ['2-1']);
  assert.equal(await fs.readFile(work.pathFor('clip', newer.id, '2-1'), 'utf8'), 'new fixture');
  work.setSettings({ ratio: '16:9' });
  const changed = await work.import(fixture);
  assert.deepEqual(changed.reused, []);
  assert.ok(changed.pending.includes('2-1'));
  assert.equal(await fs.readFile(work.pathFor('clip', id, '2-1'), 'utf8'), 'new fixture');
});

test('重启恢复远端任务，单独重试过期段并自动导出真实本地 MP4', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const clips = {};
  for (const [color, duration] of [['blue',10], ['green',10], ['red',12]]) {
    const sample = path.join(root, color + '.mp4');
    await run(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=' + color + ':s=180x320:r=30',
      '-t',String(duration),'-c:v','libx264','-pix_fmt','yuv420p', sample]);
    clips[color] = sample;
  }
  const music = path.join(root,'test-music.wav');
  await run(ffmpeg, ['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=f=330:d=2',music]);
  const submits = [];
  const phases = [];
  let work;
  const mock = {
    ...provider, create: async (_settings, _key, body) => {
      const request = JSON.parse(body);
      const txt = request.content[0].text;
      const part = txt.includes('分镜1 [') ? '1-1' : txt.includes('分镜3 [') ? '1-2' : '2-1';
      submits.push(part);
      return part + '-' + submits.filter(item => item === part).length;
    },
    query: async (_base, _key, id) => {
      if (id === '1-2-1') throw Object.assign(Error('任务已过期'), { code: 2013 });
      if (id === '1-1-1') {
        phases.push(work.snapshot().projects[0].jobs['1-1'].remoteState);
        if (phases.length === 1) return { state: 'queued' };
        if (phases.length === 2) return { state: 'running' };
      }
      return { state: 'succeeded', url: id.startsWith('1-1') ? 'blue' : id.startsWith('1-2') ? 'green' : 'red' };
    },
    download: async (color, output) => {
      if (color === 'blue') phases.push(work.snapshot().projects[0].jobs['1-1'].remoteState);
      await fs.copyFile(clips[color], output);
    },
  };
  work = new Workspace({ root: path.join(root, 'data'), secureStorage: cryptoDouble, ffmpeg, provider: mock, pollMs: 100000 });
  const { id } = await work.import(fixture);
  const project = work.project(id);
  project.segments[0].shots[0].sfx = '脚步声';
  await work.setMusic(id, music);
  keys(work);
  assert.equal(work.queue(id), 3);
  await until(work, () => Object.values(project.jobs).filter(job => job.status === 'remote').length === 2);
  await delay(80);
  assert.deepEqual([...submits].sort(), ['1-1','1-2']);
  work = new Workspace({ root: work.root, secureStorage: cryptoDouble, ffmpeg, provider: mock, pollMs: 1 });
  const restored = work.project(id);
  for (const job of Object.values(restored.jobs)) job.nextAt = 0;
  await until(work, () => restored.jobs['1-2'].status === 'failed' &&
    restored.jobs['1-1'].status === 'done' && restored.jobs['2-1'].status === 'done');
  assert.deepEqual(phases, [null, 'queued', 'running', 'downloading']);
  assert.equal(restored.jobs['1-2'].error.code, 2013);
  work.retry(id, '1-2');
  await until(work, () => ['done','error'].includes(restored.episode.status));
  assert.equal(restored.episode.status, 'done', restored.episode.message);
  assert.deepEqual(submits.slice(2), ['2-1','1-2']);
  const output = work.pathFor('episode', id);
  const result = await probe(ffmpeg, output, root);
  assert.ok(Math.abs(result.duration - 32) < .12, 'duration=' + result.duration);
  assert.deepEqual([result.width, result.height, result.audio], [180, 320, true]);
  const subtitle = subtitleFile(restored.segments[0].shots.slice(2), 180, 320);
  assert.match(subtitle, /0:00:05.00,0:00:10.00.*小雅：今天涩谷，人好多。/);
  assert.equal((subtitle.match(/^Dialogue:/gm) || []).length, 1);
  const { stdout } = await run(ffmpeg, ['-v','error','-ss','17','-i',output,'-frames:v','1','-vf','crop=180:90:0:230','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], { encoding: 'buffer' });
  let subtitlePixels = 0;
  for (let i = 0; i < stdout.length; i += 3) if (stdout[i] > 180 && stdout[i + 1] > 180 && stdout[i + 2] > 180) subtitlePixels++;
  assert.ok(subtitlePixels > 40, '白色字幕像素数 ' + subtitlePixels);
  const { stderr } = await run(ffmpeg, ['-hide_banner','-i',output,'-vf','blackdetect=d=0.03:pix_th=0.10','-an','-f','null','-']);
  assert.ok(!stderr.includes('black_start:'), stderr);
  const { stderr: sound } = await run(ffmpeg, ['-hide_banner','-i',output,'-vn','-af','volumedetect','-f','null','-']);
  assert.match(sound, /mean_volume: -[1-5]\d\.\d dB/);
  if (process.env.DUANJU_TEST_MP4) await fs.copyFile(output, process.env.DUANJU_TEST_MP4);
});

test('重启遇到未确认的提交时停止自动重发', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  const { id } = await work.import(fixture);
  const project = work.project(id);
  const part = projectIO.plan(project.segments[1])[0];
  project.jobs[part.id] = work.makeJob(project, project.segments[1], part, work.settings());
  project.jobs[part.id].status = 'submitting';
  work.save();
  const recovered = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  assert.equal(recovered.project(id).jobs[part.id].status, 'uncertain');
});


const realShapePath = path.join(__dirname, 'fixtures', 'real-shape-project.json');
async function realShape() {
  return projectIO.normalize(JSON.parse(await fs.readFile(realShapePath, 'utf8')));
}
function validImages(project) {
  const images = {};
  for (const file of [project.segments.map(s => s.gridImage), project.characters.map(c => c.image),
    project.scenes.map(s => s.image), project.assets.map(a => a.image)].flat()) {
    if (file) images[file] = { width: 100, height: 100, valid: true };
  }
  return { ...project, images };
}

test('真实包形状：存量绑定为准，场景从资产派生，四宫格提示词保留', async () => {
  const project = await realShape();
  assert.equal(project.segments.length, 2);
  assert.equal(project.segments.reduce((sum, s) => sum + s.shots.length, 0), 8);
  assert.deepEqual(project.scenes.map(item => item.name), ['涩谷十字路口', '便利店']);
  assert.deepEqual(project.assets.map(item => item.name), ['卡片', '空气墙']);
  assert.equal(project.characters.length, 2);
  const seg1 = project.segments[0];
  assert.equal(seg1.gridImage, 'images/segment-01-shots-1-4.webp');
  assert.match(seg1.gridPrompt, /^四宫格分镜图/);
  assert.equal(seg1.shots[0].dialogue, null);
  assert.deepEqual(seg1.shots[3].dialogue, { speaker: '', text: '今天涩谷，人好多。' });
  assert.ok(seg1.shots.every(shot => shot.visual && shot.prompt));
  // 道具绑定：卡片、空气墙名字不在画面文本里，只能靠存量 assetIds 救回来。
  const bound = projectIO.bindings(project, seg1.shots);
  assert.deepEqual(bound.characters.map(item => item.name), ['阿杰', '小雅']);
  assert.deepEqual(bound.assets.map(item => item.name), ['涩谷十字路口', '便利店', '卡片', '空气墙']);
  const part = projectIO.plan(seg1)[0];
  const first = projectIO.prompt(project, seg1, part);
  assert.ok(first.includes('卡片'), first);
  assert.ok(first.includes('空气墙'), first);
  assert.match(first, /资产锁：[^\n]*卡片/);
  assert.match(first, /资产锁：[^\n]*空气墙/);
  const issues = projectIO.inspect(validImages(project)).issues;
  assert.ok(!issues.some(item => item.message.includes('采用点名结果')), JSON.stringify(issues));
  assert.ok(!issues.some(item => item.level === 'red'), JSON.stringify(issues));
});

test('坏数据报红：画面描述含场标题残留、无人物绑定的段', async () => {
  const project = await realShape();
  const bad = JSON.parse(JSON.stringify(project));
  bad.segments[1].shots[0].visual = '中景，三分法构图，## 第二场 陨石降落';
  for (const shot of bad.segments[1].shots) { shot.charIds = []; shot.dialogue = null; shot.visual = shot.visual.replace(/小雅/g, '女孩'); }
  const issues = projectIO.inspect(validImages(bad)).issues;
  assert.ok(issues.some(item => item.level === 'red' && item.segment === 2 && /场标题/.test(item.message)), JSON.stringify(issues));
  assert.ok(issues.some(item => item.level === 'yellow' && item.segment === 2 && /无人物绑定/.test(item.message)), JSON.stringify(issues));
});

test('参考图超 9 张时按优先级取前 9 张并报出未提交的', () => {
  const characters = Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), name: '人' + (i + 1), image: 'images/c' + (i + 1) + '.webp' }));
  const scenes = [{ id: '11', name: '场景A', kind: '场景', image: 'images/s1.webp' }, { id: '12', name: '场景B', kind: '场景', image: 'images/s2.webp' }];
  const assets = [{ id: '13', name: '道具A', kind: '道具', image: 'images/p1.webp' }, { id: '14', name: '道具B', kind: '道具', image: 'images/p2.webp' }];
  const project = { characters, scenes, assets };
  const segment = { gridImage: 'images/g.webp' };
  const part = { shots: [{ charIds: ['1', '2', '3', '4', '5', '6'], assetIds: ['11', '12', '13', '14'],
    visual: '人1、人2、人3、人4、人5、人6站在场景A和场景B之间，手里拿着道具A和道具B。', prompt: '', dialogue: null }] };
  const refs = projectIO.referenceFiles(project, segment, part);
  assert.equal(refs.files.length, 9);
  assert.deepEqual(refs.dropped, ['images/p1.webp', 'images/p2.webp']);
  assert.equal(refs.files[0], 'images/g.webp');
});

test('MiniMax 按站点显示官方视频 V2 模型，DeepSeek 按 Key 拉取模型', async t => {
  const realFetch = global.fetch;
  t.after(() => { global.fetch = realFetch; });
  const root = await temp(t);
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg });
  const mainland = 'https://api.minimax.cn';
  const international = 'https://api.minimax.io';
  const models = ['MiniMax-H3', 'MiniMax-H3-Highspeed', 'MiniMax-H3-Lite', 'MiniMax-H3-Max'];
  work.data.settings = { ...work.data.settings, base: mainland, miniModels: ['MiniMax-H3', 'MiniMax-H3-Max'], resolution: '480P' };
  global.fetch = async () => assert.fail('MiniMax 视频清单不应调用其他模型接口');
  assert.deepEqual((await work.refreshModels('mini')).models, models);
  assert.equal(work.settings().resolution, '768P');
  assert.deepEqual(work.setSettings({ base: international }).miniModels, [...models, 'MiniMax-H3-Max-Turbo', 'MiniMax-H3-MG', 'MiniMax-H3-NC']);
  const lite = work.setSettings({ base: mainland, miniModel: 'MiniMax-H3-Lite', resolution: '480P', ratio: 'adaptive' });
  assert.equal(lite.miniModel, 'MiniMax-H3-Lite');
  assert.equal(lite.resolution, '480P');
  assert.equal(lite.ratio, '9:16');
  assert.deepEqual(lite.miniVideoOptions[mainland]['MiniMax-H3-Lite'], { resolutions: ['480P', '768P'], adaptive: false });
  const liteOpts = { base: mainland, miniModel: lite.miniModel, resolution: '480P', ratio: '9:16' };
  assert.doesNotThrow(() => provider.validateMiniVideoOptions(liteOpts, 4));
  assert.throws(() => provider.validateMiniVideoOptions({ ...liteOpts, ratio: 'adaptive' }, 4), /指定画幅/);
  assert.throws(() => provider.validateMiniVideoOptions({ ...liteOpts, miniModel: 'MiniMax-H3' }, 4), /不支持 480P/);
  assert.throws(() => provider.validateMiniVideoOptions({ ...liteOpts, miniModel: 'MiniMax-H3-Max' }, 4), /5–15/);
  global.fetch = async url => {
    assert.equal(url, 'https://api.deepseek.com/models');
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }, { id: 'deepseek-v3.2' }] }) };
  };
  assert.deepEqual(await provider.listDeepSeekModels('k'), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-v3.2']);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) });
  assert.deepEqual(await provider.listDeepSeekModels('k'), ['deepseek-flash', 'deepseek-v4-pro']);
  global.fetch = async () => { throw Error('offline'); };
  await assert.rejects(provider.listDeepSeekModels('k'), /网络/);
});

test('刷新模型保留已选模型，提交指纹包含模型，旧版可清理', { skip: !fixtures }, async t => {
  const root = await temp(t);
  const mock = { ...provider,
    listDeepSeekModels: async () => ['deepseek-chat', 'deepseek-reasoner'] };
  const work = new Workspace({ root, secureStorage: cryptoDouble, ffmpeg, provider: mock });
  work.setSettings({ mini: 'fake-mini-secret', deep: 'fake-deep-secret' });
  assert.ok((await work.refreshModels('mini')).models.includes('MiniMax-H3-Lite'));
  assert.equal(work.settings().miniModel, 'MiniMax-H3');
  work.setSettings({ miniModel: 'MiniMax-H3-Max' });
  assert.equal(work.settings().miniModel, 'MiniMax-H3-Max');
  assert.deepEqual((await work.refreshModels('deep')).models, ['deepseek-chat', 'deepseek-reasoner']);
  assert.equal((await work.refreshModels('mini')).model, 'MiniMax-H3-Max');
  const { id } = await work.import(fixture);
  assert.equal(work.preflight(id).settings.model, 'MiniMax-H3-Max');
  const replaced = await work.import(fixture);
  assert.equal(work.data.projects.length, 2);
  assert.deepEqual(await work.cleanupOldVersions(replaced.id), { removed: 1 });
  assert.equal(work.data.projects.length, 1);
  assert.equal(work.data.projects[0].id, replaced.id);
  assert.deepEqual(await work.cleanupOldVersions(replaced.id), { removed: 0 });
});

test('导演规则进提示词：导演判断与本镜状态按镜拼进 H3 提示词，缺字段的老包不受影响', async () => {
  const raw = JSON.parse(await fs.readFile(realShapePath, 'utf8'));
  const shot = raw.scripts[0].segments[0].shots[0];
  shot.director = { event: '小雅在人群中停下', viewpoint: '跟随小雅的过肩视角', focus: '她发现了空气墙', eyeline: '从人群进入，沿自拍杆落在她脸上', pressure: '等待' };
  shot.state = '小雅在涩谷十字路口；卡片在阿杰手中';
  shot.ledger = { function: '建立', before: '人群涌动', after: '小雅停下', dependsOn: [] };
  const project = projectIO.normalize(raw);
  const first = project.segments[0].shots[0];
  assert.equal(first.director.event, '小雅在人群中停下');
  assert.equal(first.state, '小雅在涩谷十字路口；卡片在阿杰手中');
  assert.equal(first.ledger.function, '建立');
  const text = projectIO.prompt(project, project.segments[0], projectIO.plan(project.segments[0])[0]);
  assert.match(text, /导演：小雅在人群中停下/);
  assert.match(text, /视线：从人群进入，沿自拍杆落在她脸上/);
  assert.match(text, /本镜状态：小雅在涩谷十字路口；卡片在阿杰手中/);
  const plain = await realShape();
  const plainText = projectIO.prompt(plain, plain.segments[0], projectIO.plan(plain.segments[0])[0]);
  assert.ok(!plainText.includes('导演：'), plainText);
  assert.ok(!plainText.includes('本镜状态：'), plainText);
});

test('画布验收进一致性检查：未通过报红，老包无新提醒', async () => {
  const raw = JSON.parse(await fs.readFile(realShapePath, 'utf8'));
  raw.scripts[0].segments[0].shots[1].acceptance = { status: 'fail', failed: ['道具数量不对'], evidence: '卡片出现两张', retries: 2 };
  const project = projectIO.normalize(raw);
  assert.equal(project.segments[0].shots[1].acceptance.status, 'fail');
  const issues = projectIO.inspect(validImages(project)).issues;
  assert.ok(issues.some(item => item.level === 'red' && item.shot === 2 && /画布验收未通过/.test(item.message) && /道具数量不对/.test(item.message) && /已补跑 2 次/.test(item.message)), JSON.stringify(issues));
  const plain = await realShape();
  const plainIssues = projectIO.inspect(validImages(plain)).issues;
  assert.ok(!plainIssues.some(item => /画布验收/.test(item.message)), JSON.stringify(plainIssues));
});
