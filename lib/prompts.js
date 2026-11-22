'use strict';
/**
* prompts.js — 按画布口径拼 MiniMax H3 提示词，并把超 15 秒的段均衡拆成子段。
*
* 段结构（来自导出包 project.json）：
* 段 = 整体设定（全局）＋ 本段设定 ＋ 角色音色 ＋ 4 镜（格位对照＋逐字台词）＋ 结尾状态
* 子段拆分：段总时长 > 15 秒时按总时长均衡拆，4 格各 5 秒 → 1-2 格 / 3-4 格各 10 秒。
* 台词在任何环节都逐字保留，一个字不改。
*/

const MAX_PART_SECONDS = 15;

function segmentTotalSeconds(segment) {
return (segment.shots || []).reduce((sum, s) => sum + (Number(s.durationSec) || 0), 0);
}

/** 把一段的镜均衡拆成若干子段（连续镜，不跨段）。返回 [{ shots, seconds}]。 */
function splitSegment(segment, maxPartSeconds = MAX_PART_SECONDS) {
const shots = segment.shots || [];
const total = segmentTotalSeconds(segment);
if (shots.length === 0) return [{ shots: [], seconds: 0}];
if (total <= maxPartSeconds) return [{ shots, seconds: total}];
const partsCount = Math.ceil(total / maxPartSeconds);
const target = total / partsCount;
const parts = [];
let cur = [];
let curSec = 0;
for (const shot of shots) {
const d = Number(shot.durationSec) || 0;
if (cur.length > 0 && curSec + d > target && parts.length < partsCount - 1) {
parts.push({ shots: cur, seconds: curSec});
cur = [];
curSec = 0;
}
cur.push(shot);
curSec += d;
}
if (cur.length > 0) parts.push({ shots: cur, seconds: curSec});
return parts;
}

/** 一段拆出的全部子段（带序号与时长）。 */
function segmentParts(project, segment) {
const parts = splitSegment(segment);
return parts.map((p, i) => ({
partIndex: i,
partsCount: parts.length,
shots: p.shots,
seconds: p.seconds,
}));
}

const GRID_POSITIONS = ['左上', '右上', '左下', '右下'];

function formatDialogue(shot) {
const d = shot.dialogue;
if (!d) return '无台词';
if (typeof d === 'string') return d.trim()? `台词「${d.trim()}」`: '无台词';
const text = (d.text || '').trim();
if (!text) return '无台词';
const speaker = (d.speaker || '').trim();
return speaker? `台词「${speaker}：${text}」`: `台词「${text}」`;
}

/**
* 拼一段中某个子段的 H3 提示词。
* 结构：整体设定 ＋ 本段设定 ＋ 角色音色 ＋ 格位对照 ＋ 逐镜（景别/运镜/画面/逐字台词）＋ 结尾状态。
*/
function buildPartPrompt(project, segment, part) {
const lines = [];
if (project.globalSetup) lines.push(`${project.globalSetup}`);
if (segment.setup) lines.push(`${segment.setup}`);
if (segment.voices) lines.push(`${segment.voices}`);

const gridMap = part.shots
.map((s, i) => `${GRID_POSITIONS[i] || `格${i + 1}`}→分镜${s.shotIndex}`)
.join('，');
lines.push(`${gridMap}`);
lines.push(
`第${segment.index}段／共${project.segments.length}段` +
(part.partsCount > 1? `（第${part.partIndex + 1}部分／共${part.partsCount}部分）`: '') +
`，时长约${part.seconds}秒`,
);
for (const s of part.shots) {
const span =
s.startSec!= null && s.endSec!= null? `[${s.startSec}-${s.endSec}秒]`: `[约${s.durationSec || 0}秒]`;
const shot = [s.framing, s.camera].filter(Boolean).join(' ');
const visual = (s.visual || '').trim();
lines.push(
`分镜${s.shotIndex} ${span}${shot? ` [${shot}]`: ''}${visual? ` ${visual}`: ''}；${formatDialogue(s)}${s.sfx? `；音效：${s.sfx}`: ''}`,
);
}
if (segment.endCard) lines.push(`${segment.endCard}`);
return lines.join('\n');
}

/** 该子段绑定的人物 / 场景 / 道具（按镜的 charIds / assetIds 交集去重）。 */
function partBindings(project, part) {
const charIds = new Set();
const assetIds = new Set();
for (const s of part.shots) {
(s.charIds || []).forEach((id) => charIds.add(id));
(s.assetIds || []).forEach((id) => assetIds.add(id));
}
const characters = [...charIds]
.map((id) => project.characters.find((c) => String(c.id) === String(id)))
.filter(Boolean);
const assets = [...assetIds]
.map((id) => {
const scene = project.scenes.find((x) => String(x.id) === String(id));
if (scene) return {...scene, kind: '场景'};
return project.assets.find((x) => String(x.id) === String(id));
})
.filter(Boolean);
return { characters, assets};
}

/** MiniMax H3 时长限制：4–15 秒；子段时长先取整再夹到区间内。 */
function clampDuration(seconds, min = 4, max = 15) {
const s = Math.round(Number(seconds) || 0);
return Math.max(min, Math.min(max, s));
}

module.exports = {
MAX_PART_SECONDS,
segmentTotalSeconds,
splitSegment,
segmentParts,
buildPartPrompt,
partBindings,
clampDuration,
};
