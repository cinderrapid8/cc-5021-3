import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABSTRACT_CHANNELS, MODELS, VISEME_TARGETS, DEFAULT_PHONEME_MAP,
  DEFAULT_TRANSITION, SAMPLE_SCHEDULES,
} from '../src/config.js';
import {
  parseAnnotationJSON, parseAnnotationText, normalizeSegments,
  buildTimeline, sampleAt, sampleGrid, closureAudit,
  resolveModel, buildExportPayload,
} from '../src/engine.js';
import { SimulationClock } from '../src/clock.js';

const segs = (s) => s.map(([start, end, phoneme]) => ({ start, end, phoneme }));

function timelineFrom(schedule, opts = {}) {
  return buildTimeline(segs(schedule), { model: MODELS.full, ...opts });
}

test('闭口辅音 b 在闭合时刻 lipClose 达到目标且不被相邻元音平均掉', () => {
  const tl = timelineFrom(SAMPLE_SCHEDULES.short_vowels.segments.map((s) => [s.start, s.end, s.phoneme]));
  const bEvents = tl.events.filter((e) => e.phoneme === 'b');
  assert.equal(bEvents.length, 3);
  for (const ev of bEvents) {
    const s = sampleAt(tl, ev.end);
    assert.ok(s.abstract.lipClose >= 0.95, `lipClose at ${ev.end} = ${s.abstract.lipClose}`);
  }
  // 同一时刻 jawOpen 应被压到很低（闭合优先，max 融合）
  const peak = bEvents[0];
  assert.ok(sampleAt(tl, peak.end).abstract.jawOpen < 0.15);
});

test('短于 closureHold 的闭口辅音被强制保持并记录 info', () => {
  const tl = timelineFrom([
    [0.0, 0.1, 'sil'],
    [0.1, 0.13, 'b'], // 30ms < 55ms
    [0.13, 0.3, 'a'],
  ]);
  assert.ok(tl.stats.closureEnforcedCount >= 1);
  assert.ok(tl.issues.some((i) => i.code === 'closure_hold'));
  const ev = tl.events.find((e) => e.phoneme === 'b');
  assert.ok(sampleAt(tl, ev.end).abstract.lipClose >= 0.95);
});

test('相邻元音之间存在平滑过渡（中间时刻为混合值，而非阶跃）', () => {
  const tl = timelineFrom([
    [0.0, 0.2, 'i'],
    [0.2, 0.4, 'u'],
  ]);
  const atBoundary = sampleAt(tl, 0.2).abstract;
  // i 展唇高、u 圆唇高；边界处两者都处于过渡的中间状态
  assert.ok(atBoundary.lipSpread > 0.1 && atBoundary.lipSpread < 0.8);
  assert.ok(atBoundary.lipRound > 0.1 && atBoundary.lipRound < 0.9);
});

test('长停顿期间保持中性静默姿态，不随任何幅度张嘴', () => {
  const tl = timelineFrom([
    [0.0, 0.25, 'sil'],
    [0.25, 0.33, 'b'],
    [0.33, 0.55, 'a'],
    [0.55, 1.45, 'sil'],
    [1.45, 1.53, 'b'],
    [1.53, 1.75, 'i'],
    [1.75, 2.0, 'sil'],
  ]);
  assert.equal(tl.stats.longPauseCount, 1);
  for (const t of [0.7, 1.0, 1.3]) {
    const s = sampleAt(tl, t);
    assert.ok(s.abstract.jawOpen <= VISEME_TARGETS.SIL.jawOpen + 0.02, `t=${t} jaw=${s.abstract.jawOpen}`);
    assert.equal(s.abstract.lipClose, 0);
    assert.equal(s.abstract.lipRound, 0);
  }
});

test('连续快速音节中每个闭口/舌位事件都被保留且时间互不覆盖', () => {
  const tl = timelineFrom(SAMPLE_SCHEDULES.fast_syllables.segments.map((s) => [s.start, s.end, s.phoneme]));
  const closures = tl.events.filter((e) => e.closure);
  assert.equal(closures.length, 2);
  const audit = closureAudit(tl);
  assert.equal(audit.length, 2);
  assert.ok(audit.every((r) => r.pass));
  // d/g 舌位通道在各自时刻取主导
  const dEvent = tl.events.find((e) => e.phoneme === 'd');
  assert.ok(sampleAt(tl, dEvent.end).abstract.tongueFront >= 0.5);
  const gEvent = tl.events.find((e) => e.phoneme === 'g');
  assert.ok(sampleAt(tl, gEvent.end).abstract.tongueBack >= 0.5);
});

test('确定性网格采样：等距 t_k=round(k*dt)，重复调用完全一致', () => {
  const tl = timelineFrom(SAMPLE_SCHEDULES.short_vowels.segments.map((s) => [s.start, s.end, s.phoneme]));
  const g1 = sampleGrid(tl, 0.01);
  const g2 = sampleGrid(tl, 0.01);
  assert.deepEqual(g1.samples, g2.samples);
  for (let k = 0; k < g1.count; k++) {
    assert.ok(Math.abs(g1.samples[k].t - Math.round(k * 0.01 * 1e6) / 1e6) < 1e-9);
  }
  assert.equal(g1.count, Math.floor(tl.duration / 0.01) + 1);
});

test('仿真时钟：变速与暂停恢复不累积偏差，seek 直接定位', () => {
  const c = new SimulationClock();
  c.play(0);
  c.update(0.1); // 墙钟 0→0.1，媒体 +0.1
  c.update(0.2); // 墙钟 0.1→0.2，媒体 +0.1
  assert.ok(Math.abs(c.getTime() - 0.2) < 1e-12);
  c.setRate(2);
  c.update(0.3); // 变速重置墙钟基准，该 tick 不累加（避免变速瞬间跳变）
  assert.ok(Math.abs(c.getTime() - 0.2) < 1e-12);
  c.update(0.4); // 墙钟 0.3→0.4，媒体 +0.1*2
  assert.ok(Math.abs(c.getTime() - 0.4) < 1e-12);
  c.pause();
  c.update(10);  // 暂停很久，媒体时间不动
  assert.ok(Math.abs(c.getTime() - 0.4) < 1e-12);
  c.play(10);    // 恢复时重置墙钟基准，无补偿跳跃
  c.update(10.25); // 墙钟 10→10.25，媒体 +0.25*2
  assert.ok(Math.abs(c.getTime() - 0.9) < 1e-12);
  c.seek(0.123);
  assert.equal(c.getTime(), 0.123);
});

test('受限模型：缺失形态给出替代与缺失报告，绑定到模型实际名称', () => {
  const { bindings, report } = resolveModel(MODELS.limited);
  assert.equal(bindings.jawOpen.morph, 'jaw_open');
  assert.equal(bindings.tongueFront.morph, 'jaw_open');
  assert.equal(bindings.tongueFront.mode, 'substitute');
  assert.ok(report.substitutes.some((s) => s.channel === 'lipSpread'));
  assert.deepEqual(report.dropped.sort(), []); // limited 三个缺失都有替代

  const tl = timelineFrom(SAMPLE_SCHEDULES.short_vowels.segments.map((s) => [s.start, s.end, s.phoneme]), { model: MODELS.limited });
  assert.ok(tl.issues.some((i) => i.code === 'substitute'));
  const s = sampleAt(tl, 0.45);
  // 输出键必须是模型实际 morph 名，而非抽象通道名
  for (const k of Object.keys(s.morphs)) assert.ok(MODELS.limited.morphs.includes(k));
});

test('极简模型：无替代方案的舌位通道被显式丢弃并报 error', () => {
  const { report } = resolveModel(MODELS.minimal);
  assert.ok(report.dropped.includes('tongueFront'));
  assert.ok(report.dropped.includes('tongueBack'));
  assert.ok(report.issues.some((i) => i.code === 'missing_morph' && i.level === 'error'));
  const tl = timelineFrom([[0, 0.3, 'i']], { model: MODELS.minimal });
  const s = sampleAt(tl, 0.15);
  assert.equal(s.morphs.tongueFront, undefined);
  assert.ok(s.morphs.jaw_open !== undefined);
});

test('未知音素与非法标注被明确报告，不静默失败', () => {
  const tl = buildTimeline(
    segs([[0, 0.2, 'xyz'], [0.2, 0.4, 'a']]),
    { model: MODELS.full },
  );
  assert.ok(tl.issues.some((i) => i.code === 'unknown_phoneme' && i.level === 'error'));
  assert.equal(tl.events.length, 1);

  const parsed = parseAnnotationText('0 0.1 a\nbadline\n0.1 0.2 b');
  const { issues } = normalizeSegments(parsed);
  assert.ok(issues.some((i) => i.code === 'bad_line'));
});

test('权重始终被约束在通道范围内（clamp），编辑超界也会被限制', () => {
  const targets = JSON.parse(JSON.stringify(VISEME_TARGETS));
  targets.A.jawOpen = 5; // 超界
  const tl = buildTimeline(segs([[0, 0.3, 'a']]), { model: MODELS.full, visemeTargets: targets });
  const s = sampleAt(tl, 0.15);
  assert.ok(s.abstract.jawOpen <= 1);
  for (const ch of ABSTRACT_CHANNELS) {
    const v = s.abstract[ch];
    assert.ok(v >= 0 && v <= 1, `${ch}=${v}`);
  }
});

test('标注解析器：JSON 与纯文本两种格式等价', () => {
  const json = parseAnnotationJSON('[{"start":0,"end":0.2,"phoneme":"a"},{"begin":0.2,"finish":0.4,"phone":"b"}]');
  const txt = parseAnnotationText('# comment\n0 0.2 a\n0.2 0.4 b');
  assert.equal(json.length, 2);
  assert.equal(txt.length, 2);
  assert.equal(json[1].phoneme, 'b');
  const nj = normalizeSegments(json);
  const nt = normalizeSegments(txt);
  assert.deepEqual(nj.segments, nt.segments);
});

test('重叠标注被修复并告警；未覆盖空隙被记录', () => {
  const { segments, issues } = normalizeSegments(segs([
    [0, 0.3, 'a'],
    [0.25, 0.5, 'i'], // 重叠
  ]));
  assert.ok(Math.abs(segments[1].start - 0.3) < 1e-9);
  assert.ok(issues.some((i) => i.code === 'overlap'));

  const gapped = normalizeSegments(segs([[0, 0.2, 'a'], [0.4, 0.6, 'i']]));
  assert.ok(gapped.issues.some((i) => i.code === 'uncovered_gap'));
  // 空隙处取中性零驱动
  const tl = buildTimeline(gapped.segments, { model: MODELS.full });
  const s = sampleAt(tl, 0.3);
  assert.equal(s.abstract.jawOpen, 0);
});

test('导出载荷包含权重、闭合核对、停顿与全部问题记录', () => {
  const tl = timelineFrom(SAMPLE_SCHEDULES.long_pause.segments.map((s) => [s.start, s.end, s.phoneme]));
  const payload = buildExportPayload(tl, 0.01);
  assert.equal(payload.format, 'viseme-weights-v1');
  assert.ok(payload.samples.length > 100);
  assert.ok(payload.closureAudit.length >= 2);
  assert.equal(payload.pauses.length, 1);
  assert.ok(Array.isArray(payload.issues));
  assert.ok(payload.samples.every((s) => Number.isFinite(s.t)));
});

test('内置样例计划与 config 中字段完整且时间有序', () => {
  for (const def of Object.values(SAMPLE_SCHEDULES)) {
    for (let i = 1; i < def.segments.length; i++) {
      assert.ok(def.segments[i].start >= def.segments[i - 1].end,
        `${def.id} segment overlap at ${i}`);
      assert.ok(typeof def.segments[i].phoneme === 'string' && def.segments[i].phoneme.length > 0);
    }
    // 所有非静默音素在默认映射中都能找到口型
    for (const seg of def.segments) {
      const key = seg.phoneme.toLowerCase();
      if (['sil', 'sp', 'pau'].includes(key)) continue;
      assert.ok(DEFAULT_PHONEME_MAP[key], `${def.id} 未映射音素 ${seg.phoneme}`);
      assert.ok(VISEME_TARGETS[DEFAULT_PHONEME_MAP[key]]);
    }
  }
});
