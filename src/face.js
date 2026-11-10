// 程序化变形人脸：每个抽象通道直接改变面部几何（morph 变形动画），
// 不使用任何预录人脸视频或图片序列。

export function drawFace(canvas, abstract, options = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const jaw = abstract.jawOpen || 0;
  const round = abstract.lipRound || 0;
  const spread = abstract.lipSpread || 0;
  const close = abstract.lipClose || 0;

  const cx = W / 2;
  const faceCy = H * 0.46;
  const faceW = W * 0.30;
  const faceH = H * 0.34;

  // 脸
  ctx.save();
  ctx.fillStyle = '#f2d3b3';
  ctx.strokeStyle = '#8a5a3b';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(cx, faceCy, faceW, faceH, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 眼睛（位置不受嘴部通道影响，保持稳定）
  const eyeY = faceCy - faceH * 0.22;
  const eyeDX = faceW * 0.42;
  ctx.fillStyle = '#2b2b2b';
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(cx + dir * eyeDX, eyeY, faceW * 0.10, faceH * 0.07, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // 鼻子
  ctx.strokeStyle = '#b0845f';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx, eyeY + 8);
  ctx.quadraticCurveTo(cx - 6, faceCy + faceH * 0.18, cx, faceCy + faceH * 0.28);
  ctx.stroke();

  // 嘴部几何由 morph 权重驱动
  const mouthCy = faceCy + faceH * 0.52 + jaw * faceH * 0.18; // 下颌下移
  const halfWidthBase = faceW * 0.42;
  // 展唇拉宽、圆唇收窄、闭口压缩宽度
  const halfWidth = halfWidthBase * (1 + 0.45 * spread - 0.55 * round - 0.25 * close);
  // 张嘴高度；闭合时强制趋于 0（lipClose 主导）
  const openH = faceH * 0.34 * jaw * (1 - close);
  const lipThickness = 4 + 5 * round;

  ctx.strokeStyle = '#7a2e2e';
  ctx.fillStyle = '#5c1f1f';
  ctx.lineWidth = lipThickness;
  ctx.lineJoin = 'round';

  if (close > 0.85) {
    // 完全闭合：一条双唇接触线
    ctx.beginPath();
    ctx.moveTo(cx - halfWidth, mouthCy);
    ctx.quadraticCurveTo(cx, mouthCy + 3, cx + halfWidth, mouthCy);
    ctx.stroke();
  } else {
    // 上下唇贝塞尔轮廓；圆唇时开口变小变圆
    const top = mouthCy - openH * 0.5;
    const bottom = mouthCy + openH * 0.5;
    const cornerIn = halfWidth * (1 - 0.35 * round);

    ctx.beginPath();
    ctx.moveTo(cx - cornerIn, mouthCy);
    ctx.quadraticCurveTo(cx - cornerIn * 0.4, top - 2 * round, cx, top);
    ctx.quadraticCurveTo(cx + cornerIn * 0.4, top - 2 * round, cx + cornerIn, mouthCy);
    ctx.quadraticCurveTo(cx + cornerIn * 0.4, bottom + 2 * round, cx, bottom);
    ctx.quadraticCurveTo(cx - cornerIn * 0.4, bottom + 2 * round, cx - cornerIn, mouthCy);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 口腔暗部（张嘴时可见）
    if (openH > 3) {
      ctx.fillStyle = '#2a0d0d';
      ctx.beginPath();
      ctx.ellipse(cx, mouthCy + openH * 0.08, cornerIn * 0.7, openH * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();

  if (options.label) {
    ctx.fillStyle = '#444';
    ctx.font = '13px monospace';
    ctx.fillText(options.label, 10, H - 10);
  }
}

// 通道权重竖条
export function drawChannelBars(canvas, abstract, channels) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  const pad = 8;
  const barW = (W - pad * (channels.length + 1)) / channels.length;
  ctx.font = '11px monospace';
  channels.forEach((ch, i) => {
    const x = pad + i * (barW + pad);
    const val = Math.max(0, Math.min(1, abstract[ch] || 0));
    const bh = (H - 34) * val;
    ctx.fillStyle = '#d9e2ec';
    ctx.fillRect(x, 10, barW, H - 34);
    ctx.fillStyle = val > 0.9 ? '#c0392b' : '#2f6fb0';
    ctx.fillRect(x, H - 24 - bh, barW, bh);
    ctx.fillStyle = '#333';
    ctx.fillText(ch, x, H - 8);
  });
}
