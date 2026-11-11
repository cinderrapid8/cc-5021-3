// 融合策略取舍的量化度量：全部由确定性网格采样的系数轨迹复算，
// 不接受手填数字。被 experiments/fusion/run_experiment.mjs 与测试共用。
import { sampleGrid } from '../engine.js';
import { round6 } from './kernel.js';

export const METRIC_DT = 0.005; // 200Hz，足以分辨 10ms 级的峰值时刻差异

// 在 [t0, t1] 窗口内对单通道做确定性网格采样
function channelSeries(timeline, channel, t0, t1, dt = METRIC_DT) {
  const start = Math.max(0, t0);
  const end = Math.min(timeline.duration, t1);
  const grid = sampleGrid(timeline, dt);
  const series = [];
  for (const s of grid.samples) {
    if (s.t < start - 1e-12 || s.t > end + 1e-12) continue;
    series.push({ t: s.t, v: s.abstract[channel] || 0 });
  }
  return series;
}

// 系数连续性：总变差 TV、最大单步跳变 maxStep、逐秒均方根速度 rmsVelocity
export function continuityMetrics(timeline, channels, dt = METRIC_DT) {
  const grid = sampleGrid(timeline, dt);
  const perChannel = {};
  let tvAll = 0;
  let maxStepAll = 0;
  let sumSqRate = 0;
  let rateCount = 0;
  for (const ch of channels) {
    let tv = 0;
    let maxStep = 0;
    const vals = grid.samples.map((s) => s.abstract[ch] || 0);
    for (let i = 1; i < vals.length; i++) {
      const d = Math.abs(vals[i] - vals[i - 1]);
      tv += d;
      if (d > maxStep) maxStep = d;
      tvAll += d;
      if (d > maxStepAll) maxStepAll = d;
      const rate = d / dt;
      sumSqRate += rate * rate;
      rateCount += 1;
    }
    perChannel[ch] = { tv: round6(tv), maxStep: round6(maxStep) };
  }
  return {
    dt,
    sampleCount: grid.count,
    totalVariation: round6(tvAll),
    maxStep: round6(maxStepAll),
    rmsVelocity: round6(Math.sqrt(sumSqRate / Math.max(1, rateCount))),
    perChannel,
  };
}

// 闭口时刻核对：lipClose 峰值时刻相对标注释放点（音素末端）的时间差。
// lead = releaseTime - peakTime（正值=嘴闭合得比释放点早，负值=滞后）。
export function closureTiming(timeline, dt = METRIC_DT) {
  const records = [];
  for (const ev of timeline.events) {
    if (!ev.closure) continue;
    const t0 = Math.max(0, ev.start - 0.12);
    const t1 = Math.min(timeline.duration, ev.end + 0.12);
    const series = channelSeries(timeline, 'lipClose', t0, t1, dt);
    let peak = series[0];
    for (const p of series) if (p.v > peak.v) peak = p;
    const atRelease = channelSeries(timeline, 'lipClose', ev.end, ev.end, dt)[0];
    const jawAtRelease = channelSeries(timeline, 'jawOpen', ev.end, ev.end, dt)[0];
    records.push({
      phoneme: ev.phoneme,
      releaseTime: round6(ev.end),
      peakTime: peak.t,
      peakLipClose: round6(peak.v),
      leadSec: round6(ev.end - peak.t),
      lipCloseAtRelease: atRelease ? round6(atRelease.v) : null,
      jawOpenAtRelease: jawAtRelease ? round6(jawAtRelease.v) : null,
    });
  }
  const leads = records.map((r) => r.leadSec);
  const summary = {
    count: records.length,
    meanAbsLead: round6(leads.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, leads.length)),
    maxAbsLead: round6(Math.max(...leads.map((x) => Math.abs(x)), 0)),
    meanPeakLipClose: round6(records.reduce((a, r) => a + r.peakLipClose, 0) / Math.max(1, records.length)),
  };
  return { records, summary };
}

// 过渡中点时间差：在指定边界附近，通道从一端电平过渡到另一端电平时越过 50% 中点
// 的时刻相对标注边界的偏差（正=过渡提前，负=滞后）。两端变化不足时返回 null。
export function transitionCrossover(timeline, channel, boundaryTime, dt = METRIC_DT, halfWindow = 0.2, minSwing = 0.1) {
  const t0 = Math.max(0, boundaryTime - halfWindow);
  const t1 = Math.min(timeline.duration, boundaryTime + halfWindow);
  const series = channelSeries(timeline, channel, t0, t1, dt);
  if (series.length < 3) return null;
  const v0 = series[0].v;
  const v1 = series[series.length - 1].v;
  if (Math.abs(v1 - v0) < minSwing) return null;
  const mid = (v0 + v1) / 2;
  const rising = v1 >= v0;
  for (let i = 1; i < series.length; i++) {
    const crossed = rising ? series[i].v >= mid && series[i - 1].v < mid
      : series[i].v <= mid && series[i - 1].v > mid;
    if (crossed) {
      return {
        channel,
        boundaryTime: round6(boundaryTime),
        from: round6(v0),
        to: round6(v1),
        midpoint: round6(mid),
        crossoverTime: series[i].t,
        offsetSec: round6(boundaryTime - series[i].t),
      };
    }
  }
  return null;
}

// 元音起音延迟：该元音段内 jawOpen 首次达到其段内峰值 50% 的时刻，相对音素起点的差。
export function vowelAttackDelay(timeline, ev, dt = METRIC_DT) {
  if (ev.closure || ev.relaxed) return null;
  const series = channelSeries(timeline, 'jawOpen', ev.start, ev.end, dt);
  if (series.length < 2) return null;
  let peak = series[0];
  for (const p of series) if (p.v > peak.v) peak = p;
  const half = peak.v * 0.5;
  for (const p of series) {
    if (p.v >= half) {
      return {
        phoneme: ev.phoneme,
        start: round6(ev.start),
        attackTime: p.t,
        delaySec: round6(p.t - ev.start),
        peakJawOpen: round6(peak.v),
      };
    }
  }
  return null;
}
