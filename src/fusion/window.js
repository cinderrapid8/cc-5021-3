// 策略三：显式共发音窗口。
// 每个音素拥有显式的影响窗口 [start-lead, end+lag]，窗口内音素段为满权重平台、
// 窗口两侧做 smoothstep 交叉淡化；lead/lag 随与相邻音素的间隙自适应缩放——
// 间隙越大共发音越弱，紧贴的快速音节则维持最小共发音窗口。
// 闭口辅音额外保证末端闭合保持，闭合平台对齐到释放点（音素末端）。
import { combineActive, EPS, smoothstep } from './kernel.js';
import { DEFAULT_TRANSITION } from '../config.js';

export const DEFAULT_WINDOW_PARAMS = {
  minLead: 0.02,           // 最小前向共发音（秒）
  minLag: 0.03,            // 最小后向共发音（秒）
  leadScale: 0.5,          // lead = max(minLead, leadScale * 与前一音素的间隙)
  lagScale: 0.6,           // lag   = max(minLag,   lagScale   * 与后一音素的间隙)
  closureHold: DEFAULT_TRANSITION.closureHold,
};

// 在 buildTimeline 阶段预计算窗口几何（gap 为该事件与相邻事件的时间间隔）。
export function prepareWindowEvent(seg, gapBefore, gapAfter, params, isClosure) {
  const lead = Math.max(params.minLead, gapBefore * params.leadScale);
  const lag = Math.max(params.minLag, gapAfter * params.lagScale);
  let riseStart = seg.start - lead;
  let riseEnd = seg.start;
  let fallStart = seg.end;
  let fallEnd = seg.end + lag;
  if (isClosure) {
    // 闭合平台对齐音素末端；短音素向前借满最小保持时长
    const plateauStart = Math.min(seg.start, seg.end - params.closureHold);
    riseStart = plateauStart - lead;
    riseEnd = plateauStart;
    fallStart = seg.end;
    fallEnd = seg.end + lag;
  }
  return { lead, lag, riseStart, riseEnd, fallStart, fallEnd };
}

function windowWeight(ev, t) {
  if (t < ev.winRiseStart - EPS || t > ev.winFallEnd + EPS) return 0;
  if (t < ev.winRiseEnd) return smoothstep(ev.winRiseStart, ev.winRiseEnd, t);
  if (t <= ev.winFallStart) return 1;
  return 1 - smoothstep(ev.winFallStart, ev.winFallEnd, t);
}

export const windowStrategy = {
  id: 'window',
  label: '显式共发音窗口',
  sample(timeline, t) {
    const active = [];
    for (const ev of timeline.events) {
      const w = windowWeight(ev, t);
      if (w > EPS) active.push({ ev, w });
    }
    return combineActive(timeline, active);
  },
};
