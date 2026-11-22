'use strict';
/**
 * 生成测试导出包（严格按画布「导出项目」格式）：
 *   project.json（format=duanju-canvas-export, version=1）＋ images/ 图片。
 * 内容：2 段 × 4 镜。第 1 段 4 镜各 5 秒＝20 秒（应均衡拆成 2 个 10 秒子段）；
 * 第 2 段 4 镜各 3 秒＝12 秒（不拆）。人物/场景/道具各带绑定关系。
 * 图片用 1×1 PNG 占位（只验流程，不验画质）。
 *
 * 用法：node scripts/make-test-package.js [输出路径]
 */
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');

// 1×1 透明 PNG
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8Xw8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

const project = {
  format: 'duanju-canvas-export',
  version: 1,
  canvasName: '测试画布',
  canvasId: 'test-canvas-001',
  scriptText: '# 《末日游戏》第一集（测试剧本）\n小雅在涩谷十字路口举着自拍杆直播，阿杰骑电动车经过。',
  globalSetup:
    '人物：小雅、阿杰；场景：涩谷十字路口-白天；道具：自拍杆；人数：共2人，每人只出现1次，禁克隆、禁路人；走位：小雅在斑马线中央由远向近行走，阿杰骑电动车从身侧横穿而过',
  characters: [
    { id: 'char-xiaoya', name: '小雅', description: '20岁女；长发，一小条染紫发；白色针织衫＋黑色百褶裙＋蓝色娃娃背包挂饰', image: 'images/characters/xiaoya.png' },
    { id: 'char-ajie', name: '阿杰', description: '25岁男；短发；黄色外卖骑手服', image: 'images/characters/ajie.png' },
  ],
  scenes: [
    { id: 'scene-shibuya', name: '涩谷十字路口', description: '白天，十字路口，斑马线，人流', image: 'images/assets/scene-shibuya.png' },
  ],
  assets: [
    { id: 'prop-zipaigan', name: '自拍杆', kind: '道具', description: '黑色自拍杆，小雅手持', image: 'images/assets/prop-zipaigan.png' },
  ],
  segments: [
    {
      index: 1,
      setup: '人物：小雅、阿杰；场景：涩谷十字路口-白天；道具：自拍杆；人数：共2人',
      voices: '小雅：女声，清亮，话少安静；阿杰：男声，爽朗',
      endCard: '站位：小雅在斑马线中央；光线：白天明亮；道具：自拍杆在小雅手中',
      gridImage: 'images/segment-01-shots-1-4.png',
      shots: [
        { shotIndex: 1, startSec: 0, endSec: 5, durationSec: 5, framing: '全景', camera: '固定镜头', visual: '涩谷十字路口全景，小雅在斑马线中央', dialogue: null, sfx: '', charIds: ['char-xiaoya', 'char-ajie'], assetIds: ['scene-shibuya'] },
        { shotIndex: 2, startSec: 5, endSec: 10, durationSec: 5, framing: '中景', camera: '横向轨移', visual: '阿杰骑电动车从小雅身侧横穿而过', dialogue: null, sfx: '', charIds: ['char-xiaoya', 'char-ajie'], assetIds: ['scene-shibuya'] },
        { shotIndex: 3, startSec: 10, endSec: 15, durationSec: 5, framing: '近景', camera: '手持跟拍', visual: '小雅手持自拍杆近景', dialogue: null, sfx: '', charIds: ['char-xiaoya'], assetIds: ['scene-shibuya', 'prop-zipaigan'] },
        { shotIndex: 4, startSec: 15, endSec: 20, durationSec: 5, framing: '近景', camera: '固定镜头', visual: '小雅对镜头说话', dialogue: { speaker: '小雅', text: '今天涩谷，人好多。' }, sfx: '', charIds: ['char-xiaoya', 'char-ajie'], assetIds: ['scene-shibuya', 'prop-zipaigan'] },
      ],
    },
    {
      index: 2,
      setup: '人物：小雅；场景：涩谷十字路口-白天；道具：自拍杆；人数：共1人',
      voices: '小雅：女声，清亮，话少安静',
      endCard: '站位：小雅在路边；光线：白天明亮',
      gridImage: 'images/segment-02-shots-5-8.png',
      shots: [
        { shotIndex: 5, startSec: 0, endSec: 3, durationSec: 3, framing: '中景', camera: '固定镜头', visual: '小雅站在路边看手机', dialogue: null, sfx: '', charIds: ['char-xiaoya'], assetIds: ['scene-shibuya'] },
        { shotIndex: 6, startSec: 3, endSec: 6, durationSec: 3, framing: '特写', camera: '推镜', visual: '手机屏幕特写', dialogue: null, sfx: '', charIds: ['char-xiaoya'], assetIds: ['scene-shibuya'] },
        { shotIndex: 7, startSec: 6, endSec: 9, durationSec: 3, framing: '近景', camera: '固定镜头', visual: '小雅抬头看向远方', dialogue: { speaker: '小雅', text: '开始了。' }, sfx: '', charIds: ['char-xiaoya'], assetIds: ['scene-shibuya'] },
        { shotIndex: 8, startSec: 9, endSec: 12, durationSec: 3, framing: '全景', camera: '拉镜', visual: '十字路口全景，人流涌动', dialogue: null, sfx: '', charIds: ['char-xiaoya'], assetIds: ['scene-shibuya'] },
      ],
    },
  ],
};

function main() {
  const out = process.argv[2] || path.join(__dirname, '..', 'test', 'test-package.zip');
  const zip = new AdmZip();
  zip.addFile('project.json', Buffer.from(JSON.stringify(project, null, 2), 'utf8'));
  for (const img of [
    'images/segment-01-shots-1-4.png',
    'images/segment-02-shots-5-8.png',
    'images/characters/xiaoya.png',
    'images/characters/ajie.png',
    'images/assets/scene-shibuya.png',
    'images/assets/prop-zipaigan.png',
  ]) {
    zip.addFile(img, PNG_1X1);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  zip.writeZip(out);
  console.log(`测试包已生成：${out}（2 段 8 镜，6 张图）`);
}

if (require.main === module) main();
module.exports = { project };
