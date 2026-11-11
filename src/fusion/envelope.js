// 策略一（既有基线）：固定 attack/release 斜坡包络 + 闭口辅音末端闭合保持。
// 从 engine.js 原样抽取，保证旧样例逐点数值不变。
import { combineActive, EPS, smoothstep } from './kernel.js';

function eventWeight(ev, t) {
  if (t < ev.riseStart - EPS || t > ev.fallEnd + EPS) return 0;
  if (t < ev.riseEnd) return smoothstep(ev.riseStart, ev.riseEnd, t);
  if (t <= ev.fallStart) return 1;
  return 1 - smoothstep(ev.fallStart, ev.fallEnd, t);
}

export const envelopeStrategy = {
  id: 'envelope',
  label: '固定斜坡包络（既有基线）',
  sample(timeline, t) {
    const active = [];
    for (const ev of timeline.events) {
      const w = eventWeight(ev, t);
      if (w > EPS) active.push({ ev, w });
    }
    return combineActive(timeline, active);
  },
};
