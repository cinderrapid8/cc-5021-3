// 冒烟测试：在无浏览器环境下用最小桩对象走通 UI 依赖的全部模块管线。
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, SAMPLE_SCHEDULES, DEFAULT_PHONEME_MAP, ABSTRACT_CHANNELS } from '../src/config.js';
import { buildTimeline, sampleAt, sampleGrid, buildExportPayload, closureAudit } from '../src/engine.js';
import { synthPcm, encodeWav, computePeaks } from '../src/synth.js';
import { drawFace, drawChannelBars } from '../src/face.js';
import { drawWaveform, timeFromPointer } from '../src/waveform.js';
import { drawCurves } from '../src/curves.js';
import { MediaClock, SimulationClock } from '../src/clock.js';

// 无操作 2D 上下文桩：允许任意方法调用与属性赋值
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (..._args) => ({ width: 10 });
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
}
function makeCanvas(w = 640, h = 320) {
  return { width: w, height: h, getContext: () => makeCtx(), getBoundingClientRect: () => ({ left: 0, width: w }) };
}

test('完整管线：合成音频→时间线→逐时钟求值→画布绘制→导出，无异常', () => {
  const def = SAMPLE_SCHEDULES.fast_syllables;
  const schedule = {
    duration: def.segments[def.segments.length - 1].end,
    segments: def.segments,
    visemeLookup: (key) => DEFAULT_PHONEME_MAP[key] ?? null,
  };
  const pcm = synthPcm(schedule, def.sampleRate);
  assert.equal(pcm.length, Math.ceil(schedule.duration * def.sampleRate));
  const blob = encodeWav(pcm, def.sampleRate);
  assert.ok(blob.size > 1000);
  const peaks = computePeaks(pcm, 500);
  assert.equal(peaks.length, 500);

  const tl = buildTimeline(def.segments, { model: MODELS.full });

  // 仿真媒体时钟驱动逐帧求值（替代 rAF 帧循环的核心路径）
  const sim = new SimulationClock();
  sim.play(0);
  const face = makeCanvas();
  const bars = makeCanvas(640, 110);
  const wave = makeCanvas(900, 180);
  const curves = makeCanvas(900, 240);
  for (let wall = 0; wall <= 1.5; wall += 1 / 60) {
    const t = sim.update(wall);
    const s = sampleAt(tl, t);
    for (const ch of ABSTRACT_CHANNELS) assert.ok(s.abstract[ch] >= 0 && s.abstract[ch] <= 1);
    drawFace(face, s.abstract);
    drawChannelBars(bars, s.abstract, ABSTRACT_CHANNELS);
    drawWaveform(wave, peaks, tl, t, tl.duration);
    drawCurves(curves, tl, t, 0.01);
  }

  // 三个模型都要能完整走通（含替代/缺失路径）
  for (const model of Object.values(MODELS)) {
    const mTl = buildTimeline(def.segments, { model });
    const payload = buildExportPayload(mTl, 0.01);
    assert.ok(payload.samples.length > 0);
    assert.ok(Array.isArray(payload.issues));
    const audit = closureAudit(mTl);
    assert.ok(audit.every((r) => r.pass), `模型 ${model.id} 闭合核对失败`);
  }
});

test('MediaClock 用媒体元素时间作为唯一求值依据，seek/变速直接转发', () => {
  const media = { currentTime: 0, duration: 2, paused: true, playbackRate: 1, play() {}, pause() {} };
  const clock = new MediaClock(media);
  media.currentTime = 0.42;
  assert.equal(clock.getTime(), 0.42); // 不维护自己的累计量
  clock.seek(1.2);
  assert.equal(media.currentTime, 1.2);
  clock.setRate(1.5);
  assert.equal(media.playbackRate, 1.5);
  assert.throws(() => clock.setRate(0), /正数/);
});

test('波形坐标换算被限制在 [0, duration]', () => {
  const canvas = makeCanvas(900, 180);
  assert.equal(timeFromPointer(canvas, -50, 2), 0);
  assert.equal(timeFromPointer(canvas, 1000, 2), 2);
  assert.ok(Math.abs(timeFromPointer(canvas, 450, 2) - 1) < 1e-9);
});

test('网格采样与逐点采样在同一时刻结果一致（两条求值路径等价）', () => {
  const def = SAMPLE_SCHEDULES.short_vowels;
  const tl = buildTimeline(def.segments, { model: MODELS.limited });
  const grid = sampleGrid(tl, 0.01);
  for (const g of grid.samples) {
    const one = sampleAt(tl, g.t);
    assert.deepEqual(one.morphs, g.morphs);
    assert.deepEqual(one.abstract, g.abstract);
  }
});
