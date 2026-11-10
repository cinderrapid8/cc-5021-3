// 波形 + 音素边界对照视图。
// 点击/拖动只改变媒体时钟位置；波形只用于可视化，不参与口型求值。

export function drawWaveform(canvas, peaks, timeline, mediaTime, duration, options = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const D = duration || timeline?.duration || 1;
  ctx.clearRect(0, 0, W, H);

  // 背景
  ctx.fillStyle = '#101826';
  ctx.fillRect(0, 0, W, H);

  // 波形
  if (peaks && peaks.length) {
    ctx.fillStyle = '#5aa9e6';
    const mid = H * 0.55;
    const barW = W / peaks.length;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const h = Math.max(1, p * H * 0.7);
      ctx.fillRect(i * barW, mid - h / 2, Math.max(1, barW - 0.3), h);
    }
  }

  // 音素边界与标签
  if (timeline) {
    const toX = (t) => (t / D) * W;
    for (const seg of timeline.segments) {
      const x = toX(seg.start);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    ctx.font = '11px monospace';
    ctx.textBaseline = 'top';
    for (const seg of timeline.segments) {
      const x0 = toX(seg.start);
      const x1 = toX(seg.end);
      const isSil = seg.phoneme.toLowerCase() === 'sil' || seg.phoneme.toLowerCase() === 'sp' || seg.phoneme.toLowerCase() === 'pau';
      if (isSil) {
        ctx.fillStyle = 'rgba(180,180,180,0.18)';
        ctx.fillRect(x0, 0, x1 - x0, H);
      }
      ctx.fillStyle = isSil ? '#9aa5b1' : '#ffd166';
      if (x1 - x0 > 14) ctx.fillText(seg.phoneme, x0 + 3, 4);
    }
    // 闭口辅音高亮标记
    ctx.fillStyle = '#ef476f';
    for (const ev of timeline.events) {
      if (!ev.closure) continue;
      const x = toX(ev.end);
      ctx.beginPath();
      ctx.arc(x, H - 8, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // 播放头（媒体时钟）
  const playX = (Math.max(0, Math.min(mediaTime, D)) / D) * W;
  ctx.strokeStyle = '#06d6a0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, H);
  ctx.stroke();
}

export function timeFromPointer(canvas, clientX, duration) {
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  return ratio * duration;
}
