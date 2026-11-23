'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
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
const { probe, subtitleFile } = require('../src/render');
const run = promisify(execFile);
const fixture = path.join(fixtures || '', '示例包', 'test-package.zip');
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
  assert.ok(body.content[1].image_url.startsWith('data:image/png;base64,'));
  assert.equal(body.content[1].role, 'reference_image');
  assert.ok(!JSON.stringify(body).includes('first_frame'));
  await assert.rejects(provider.prepare({}, second, Array(10).fill('unused'), 10), /1–9/);
});

test('真实交接分镜：逐列比对全部 50 镜，计算场次与人物绑定', { skip: !fixtures }, async () => {
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
  assert.throws(() => work.queue(id), /缺少 DeepSeek Key/);
  keys(work);
  assert.equal(work.snapshot().settings.miniSuffix, 'cret');
  assert.ok(!(await fs.readFile(work.stateFile, 'utf8')).includes('fake-mini-secret'));
  assert.equal(work.queue(id, 2), 1);
  await until(work, () => Boolean(work.data.hold));
  assert.equal(work.project(id).jobs['2-1'].error.code, 1004);
  assert.equal(Object.keys(work.project(id).jobs).length, 1);
  assert.throws(() => work.queue(id), /暂停/);
  const replaced = await work.import(fixture);
  assert.equal(replaced.replaced, true);
  assert.notEqual(replaced.id, id);
  assert.equal(work.data.projects.length, 1);
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
      return { state: 'succeeded', url: id.startsWith('1-1') ? 'blue' : id.startsWith('1-2') ? 'green' : 'red' };
    },
    download: async (color, output) => fs.copyFile(clips[color], output),
  };
  let work = new Workspace({ root: path.join(root, 'data'), secureStorage: cryptoDouble, ffmpeg, provider: mock, pollMs: 100000 });
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

