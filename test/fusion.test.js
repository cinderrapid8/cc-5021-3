// 融合策略与实验度量测试：数字由引擎/度量代码当场复算，不允许用默认值遮错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildTimeline, sampleAt, sampleGrid, buildExportPayload,
} from '../src/engine.js';
import { MODELS, ABSTRACT_CHANNELS } from '../src/config.js';
import { FUSION_STRATEGIES, FUSION_DEFAULT_PARAMS, normalizeFusion } from '../src/fusion/index.js';
import { DEFAULT_CENTER_PARAMS } from '../src/fusion/center.js';
import { DEFAULT_WINDOW_PARAMS } from '../src/fusion/window.js';
import {
  continuityMetrics, closureTiming, transitionCrossover, vowelAttackDelay, METRIC_DT,
} from '../src/fusion/metrics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const annotation = JSON.parse(readFileSync(join(HERE, '..', 'experiments', 'fusion', 'coarticulation_closure.json'), 'utf8'));
const SEGMENTS = annotation.segments;

function makeTimeline(strategy) {
  return buildTimeline(SEGMENTS, {
    model: MODELS.full,
    fusion: { strategy, params: FUSION_DEFAULT_PARAMS[strategy] },
  });
}

test('融合注册表暴露三个可切换策略，未知策略归一到 envelope', () => {
  assert.deepEqual(Object.keys(FUSION_STRATEGIES).sort(), ['center', 'envelope', 'window']);
  assert.equal(normalizeFusion({ strategy: 'nope' }).strategy, 'envelope');
  assert.equal(normalizeFusion(null).strategy, 'envelope');
  const norm = normalizeFusion({ strategy: 'center', params: { radiusPadding: 0.09 } });
  assert.equal(norm.strategy, 'center');
  assert.equal(norm.params.radiusPadding, 0.09);
  assert.equal(norm.params.minRadius, DEFAULT_CENTER_PARAMS.minRadius); // 默认值仍补齐
});

test('事件在时间线构建时同时带齐 center 与 window 的预计算几何', () => {
  const tl = makeTimeline('envelope'); // 即使当前选 envelope 也预算另两套几何
  for (const ev of tl.events) {
    assert.ok(Number.isFinite(ev.center) && Number.isFinite(ev.radius));
    assert.ok(ev.radius >= DEFAULT_CENTER_PARAMS.minRadius - 1e-12);
    assert.ok(ev.winRiseStart <= ev.start + 1e-12);
    assert.ok(ev.winFallEnd >= ev.end - 1e-12);
    assert.ok(ev.lead >= DEFAULT_WINDOW_PARAMS.minLead - 1e-12);
    assert.ok(ev.lag >= DEFAULT_WINDOW_PARAMS.minLag - 1e-12);
  }
});

test('envelope 为默认策略：不传 fusion 时时间线行为与历史一致', () => {
  const tlLegacy = buildTimeline(SEGMENTS, { model: MODELS.full });
  assert.equal(tlLegacy.fusion.strategy, 'envelope');
  const tlExplicit = makeTimeline('envelope');
  const g1 = sampleGrid(tlLegacy, 0.01);
  const g2 = sampleGrid(tlExplicit, 0.01);
  assert.deepEqual(g1.samples, g2.samples);
});

test('center：闭口峰值时刻等于音素中心，且对短辅音显著早于释放点', () => {
  const tl = makeTimeline('center');
  const { records } = closureTiming(tl, METRIC_DT);
  const shortB = tl.events.find((e) => e.phoneme === 'b' && Math.abs(e.end - 0.125) < 1e-9);
  const rec = records.find((r) => r.releaseTime === 0.125);
  // 中心 = (0.100+0.125)/2 = 0.1125，网格 0.005 下峰值落在 0.110 或 0.115
  assert.ok(Math.abs(rec.peakTime - shortB.center) <= METRIC_DT,
    `peakTime=${rec.peakTime} center=${shortB.center}`);
  assert.ok(rec.leadSec >= 0.01 && rec.leadSec <= 0.02);
  // 同一事件 window 策略的 lead 明显更大（峰值锚在释放点一侧）
  const tlWin = makeTimeline('window');
  const recWin = closureTiming(tlWin, METRIC_DT).records.find((r) => r.releaseTime === 0.125);
  assert.ok(recWin.leadSec > rec.leadSec + 0.03);
});

test('window：闭口平台对齐释放点，释放时刻 lipClose 达目标且 jawOpen 被压低', () => {
  const tl = makeTimeline('window');
  for (const ev of tl.events.filter((e) => e.closure)) {
    const s = sampleAt(tl, ev.end);
    assert.ok(s.abstract.lipClose >= 0.95, `lipClose at ${ev.end}=${s.abstract.lipClose}`);
    assert.ok(s.abstract.jawOpen < 0.15, `jawOpen at ${ev.end}=${s.abstract.jawOpen}`);
  }
});

test('两策略在同一标注上的时间差/连续性差异方向稳定（实验核心取舍）', () => {
  const c = makeTimeline('center');
  const w = makeTimeline('window');
  const cc = closureTiming(c, METRIC_DT).summary;
  const cw = closureTiming(w, METRIC_DT).summary;
  // center 的峰值更靠近中心 → 平均绝对 lead 更小
  assert.ok(cc.meanAbsLead < cw.meanAbsLead);
  const mc = continuityMetrics(c, ABSTRACT_CHANNELS, METRIC_DT);
  const mw = continuityMetrics(w, ABSTRACT_CHANNELS, METRIC_DT);
  // window 的平台+交叉淡化产生更大的单步跳变
  assert.ok(mw.maxStep > mc.maxStep * 1.5);
  // 两策略总变差同量级（没有一方明显更“抖”）
  assert.ok(Math.abs(mw.totalVariation - mc.totalVariation) / mc.totalVariation < 0.1);
});

test('center 对边界抖动更敏感：多种子 lead 标准差大于 window', () => {
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function jitter(seed) {
    const rng = makeRng(seed);
    return SEGMENTS.map((seg) => ({
      ...seg,
      start: Math.max(0, seg.start + (rng() * 2 - 1) * 0.02),
      end: Math.max(seg.start + 0.005, seg.end + (rng() * 2 - 1) * 0.02),
    }));
  }
  const leadStd = (strategy) => {
    const perRecord = [];
    for (const seed of [11, 23, 37]) {
      const tl = buildTimeline(jitter(seed), {
        model: MODELS.full,
        fusion: { strategy, params: FUSION_DEFAULT_PARAMS[strategy] },
      });
      closureTiming(tl, METRIC_DT).records.forEach((r, i) => {
        (perRecord[i] ||= []).push(r.leadSec);
      });
    }
    const stds = perRecord.map((vals) => {
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      return Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    });
    return stds.reduce((a, b) => a + b, 0) / stds.length;
  };
  assert.ok(leadStd('center') > leadStd('window') * 2);
});

test('短音素丢弃后三策略都丢失闭合事件：融合层无法补偿标注缺失', () => {
  const dropped = SEGMENTS.filter((s) => s.end - s.start >= 0.04);
  const cleanCount = closureTiming(makeTimeline('window'), METRIC_DT).summary.count;
  for (const strategy of ['envelope', 'center', 'window']) {
    const tl = buildTimeline(dropped, {
      model: MODELS.full,
      fusion: { strategy, params: FUSION_DEFAULT_PARAMS[strategy] },
    });
    const count = closureTiming(tl, METRIC_DT).summary.count;
    assert.ok(count < cleanCount);
  }
});

test('度量函数：连续性数值由轨迹复算且确定性可重复', () => {
  const tl = makeTimeline('center');
  const m1 = continuityMetrics(tl, ABSTRACT_CHANNELS, METRIC_DT);
  const m2 = continuityMetrics(tl, ABSTRACT_CHANNELS, METRIC_DT);
  assert.deepEqual(m1, m2);
  assert.ok(m1.totalVariation > 0 && m1.maxStep > 0 && m1.rmsVelocity > 0);
  assert.ok(m1.sampleCount === sampleGrid(tl, METRIC_DT).count);
  for (const ch of ABSTRACT_CHANNELS) {
    const pc = m1.perChannel[ch];
    assert.ok(pc.tv >= pc.maxStep - 1e-9); // 总变差不小于任一单步
  }
});

test('transitionCrossover 对摆幅不足的通道返回 null，对真实过渡返回带符号偏差', () => {
  const tl = makeTimeline('window');
  const hit = transitionCrossover(tl, 'jawOpen', 1.44, METRIC_DT, 0.09, 0.05);
  assert.ok(hit && Number.isFinite(hit.offsetSec));
  const miss = transitionCrossover(tl, 'lipRound', 1.53, METRIC_DT, 0.09, 0.5);
  assert.equal(miss, null);
});

test('vowelAttackDelay 对闭口/静默返回 null，对元音返回非负延迟', () => {
  const tl = makeTimeline('center');
  const vowel = tl.events.find((e) => e.phoneme === 'a');
  const a = vowelAttackDelay(tl, vowel, METRIC_DT);
  assert.ok(a && a.delaySec >= 0 && a.peakJawOpen > 0);
  const closure = tl.events.find((e) => e.closure);
  assert.equal(vowelAttackDelay(tl, closure, METRIC_DT), null);
});

test('导出载荷带 fusion 描述，且三策略输出通道值都在范围内', () => {
  for (const strategy of ['envelope', 'center', 'window']) {
    const tl = makeTimeline(strategy);
    const payload = buildExportPayload(tl, 0.01);
    assert.equal(payload.fusion.strategy, strategy);
    for (const s of payload.samples) {
      for (const ch of ABSTRACT_CHANNELS) {
        const v = s.abstract[ch];
        assert.ok(v >= 0 && v <= 1, `${strategy} ${ch}=${v} at ${s.t}`);
      }
    }
  }
});

test('实验标注全部音素可映射且时间有序', () => {
  const tl = makeTimeline('envelope');
  // 每个段（含静默）都应产生一个事件，无 unknown_phoneme error
  assert.equal(tl.events.length, SEGMENTS.length);
  assert.ok(!tl.issues.some((i) => i.code === 'unknown_phoneme'));
  for (let i = 1; i < SEGMENTS.length; i++) {
    assert.ok(SEGMENTS[i].start >= SEGMENTS[i - 1].end);
  }
});

test('空时间线（全部音素未知）在三策略下都返回零驱动而非抛错', () => {
  for (const strategy of ['envelope', 'center', 'window']) {
    const tl = buildTimeline([{ start: 0, end: 0.2, phoneme: 'qqunknown' }], {
      fusion: { strategy, params: FUSION_DEFAULT_PARAMS[strategy] },
    });
    const s = sampleAt(tl, 0.1);
    assert.equal(tl.events.length, 0);
    for (const ch of ABSTRACT_CHANNELS) assert.equal(s.abstract[ch], 0);
  }
});
