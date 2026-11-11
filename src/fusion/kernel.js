// 融合策略共享的数学核：不依赖 engine.js，避免循环依赖。
import { ABSTRACT_CHANNELS } from '../config.js';

export const EPS = 1e-9;

export function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

export function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const u = clamp01((x - edge0) / (edge1 - edge0));
  return u * u * (3 - 2 * u);
}

export function round6(x) { return Math.round(x * 1e6) / 1e6; }

function clampToRange(timeline, ch, value) {
  const range = timeline.channelRanges[ch] || { min: 0, max: 1 };
  return Math.min(range.max, Math.max(range.min, value));
}

// 各策略共用的通道融合规则：average / max / sum + 闭口对 jawOpen 的硬性抑制。
// active: [{ ev, w }]，w 为该时刻策略自身求出的事件权重（0..1）。
export function combineActive(timeline, active) {
  const out = {};
  let closurePressure = 0;
  for (const { ev, w } of active) {
    if (ev.closure) closurePressure = Math.max(closurePressure, w);
  }
  for (const ch of ABSTRACT_CHANNELS) {
    let value;
    if (active.length === 0) {
      value = 0;
    } else {
      const mode = timeline.channelCombine[ch] || 'average';
      if (mode === 'max') {
        value = 0;
        for (const { ev, w } of active) value = Math.max(value, w * (ev.target[ch] || 0));
      } else if (mode === 'sum') {
        value = 0;
        for (const { ev, w } of active) value += w * (ev.target[ch] || 0);
      } else {
        let num = 0;
        let den = 0;
        for (const { ev, w } of active) {
          num += w * (ev.target[ch] || 0);
          den += w;
        }
        value = den > EPS ? num / den : 0;
      }
    }
    // 闭口辅音对张嘴通道的硬性抑制：嘴唇闭合时不允许下颌保持张开姿态
    if (ch === 'jawOpen' && closurePressure > 0) {
      value *= (1 - 0.85 * closurePressure);
    }
    out[ch] = clampToRange(timeline, ch, value);
  }
  return out;
}
