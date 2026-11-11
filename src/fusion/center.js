// 策略二：按音素中心距离加权。
// 每个音素在其时间中心取得峰值权重，向外按半径内的平滑核衰减；
// 不做任何边界对齐——短辅音的闭合峰值因此会出现在音素中心而非释放点，
// 这正是与显式窗口策略的可测量差异（见 experiments/fusion）。
import { combineActive, EPS, smoothstep } from './kernel.js';

export const DEFAULT_CENTER_PARAMS = {
  radiusScale: 1.0,    // 半径 = max(minRadius, radiusScale * (时长/2 + radiusPadding))
  radiusPadding: 0.04, // 邻域填充，保证极短音素仍有可感知的共发音范围
  minRadius: 0.05,     // 最小半径（秒），防止短音素权重支撑域坍缩
};

// 在 buildTimeline 阶段预计算中心核几何，采样器只做距离求值。
export function prepareCenterEvent(seg, params) {
  const duration = seg.end - seg.start;
  const center = (seg.start + seg.end) / 2;
  const radius = Math.max(
    params.minRadius,
    params.radiusScale * (duration / 2 + params.radiusPadding),
  );
  return { center, radius };
}

function kernelWeight(ev, t) {
  const d = Math.abs(t - ev.center);
  if (d >= ev.radius - EPS) return 0;
  // 平滑下降核：中心处 1、支撑域边缘 0，一阶连续
  return smoothstep(1, 0, d / ev.radius);
}

export const centerStrategy = {
  id: 'center',
  label: '音素中心距离加权',
  sample(timeline, t) {
    const active = [];
    for (const ev of timeline.events) {
      const w = kernelWeight(ev, t);
      if (w > EPS) active.push({ ev, w });
    }
    return combineActive(timeline, active);
  },
};
