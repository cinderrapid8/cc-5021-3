// 权重曲线视图：展示各抽象通道在整个时间线上的曲线。
// 曲线由引擎的确定性网格采样预先计算，播放头只负责指示当前媒体时间。

import { sampleGrid } from './engine.js';
import { ABSTRACT_CHANNELS } from './config.js';

const COLORS = {
  jawOpen: '#5aa9e6',
  lipRound: '#b388ff',
  lipSpread: '#ffd166',
  lipClose: '#ef476f',
  tongueFront: '#06d6a0',
  tongueBack: '#f77f00',
};

export function drawCurves(canvas, timeline, mediaTime, dt = 0.01, channels = ABSTRACT_CHANNELS) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const D = timeline.duration || 1;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0d1521';
  ctx.fillRect(0, 0, W, H);

  // 网格
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const y = (g / 4) * (H - 24) + 10;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const grid = sampleGrid(timeline, dt);
  const toX = (t) => (t / D) * W;
  const toY = (v) => H - 14 - v * (H - 26);

  // 音素边界
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  for (const seg of timeline.segments) {
    const x = toX(seg.start);
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, H - 14);
    ctx.stroke();
  }

  // 曲线
  for (const ch of channels) {
    ctx.strokeStyle = COLORS[ch] || '#fff';
    ctx.lineWidth = ch === 'lipClose' ? 2.2 : 1.6;
    ctx.beginPath();
    grid.samples.forEach((s, i) => {
      const x = toX(s.t);
      const y = toY(s.abstract[ch] || 0);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 图例
  ctx.font = '11px monospace';
  let lx = 8;
  for (const ch of channels) {
    ctx.fillStyle = COLORS[ch] || '#fff';
    ctx.fillText(ch, lx, H - 2);
    lx += ctx.measureText(ch).width + 14;
  }

  // 播放头
  const playX = toX(Math.max(0, Math.min(mediaTime, D)));
  ctx.strokeStyle = '#06d6a0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, H);
  ctx.stroke();
}
