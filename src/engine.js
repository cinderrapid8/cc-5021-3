// 纯函数核心引擎：不访问 DOM、不依赖 requestAnimationFrame、不读取音频音量。
// 唯一的求值输入是时间 t（秒），因此拖动/变速/暂停恢复都不会累积偏差。

import {
  ABSTRACT_CHANNELS, CHANNEL_RANGES, CHANNEL_COMBINE,
  VISEME_TARGETS, DEFAULT_PHONEME_MAP, DEFAULT_TRANSITION, SIL,
} from './config.js';

const EPS = 1e-9;

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function smoothstep(edge0, edge1, x) {
  if (edge1 === edge0) return x < edge0 ? 0 : 1;
  const u = clamp01((x - edge0) / (edge1 - edge0));
  return u * u * (3 - 2 * u);
}

function round6(x) { return Math.round(x * 1e6) / 1e6; }

function durationOf(segments) {
  return segments.length ? segments[segments.length - 1].end : 0;
}

// ---------------------------------------------------------------------------
// 标注解析
// ---------------------------------------------------------------------------

// JSON：可以是 [seg,...] 或 { segments: [seg,...] }
// 兼容字段别名 start/begin, end/finish, phoneme/phone/label
export function parseAnnotationJSON(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`标注 JSON 解析失败: ${err.message}`);
  }
  const raw = Array.isArray(data) ? data : (data.segments || data.phones || []);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('标注内容为空或缺少 segments 数组');
  }
  return raw.map(normalizeRawSegment);
}

// 纯文本：每行 "start end phoneme"（秒，空白分隔，# 开头为注释）
export function parseAnnotationText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      out.push({ raw: line, _bad: true, reason: '字段不足，需要 start end phoneme' });
      continue;
    }
    const start = Number(parts[0]);
    const end = Number(parts[1]);
    const phoneme = parts.slice(2).join(' ');
    out.push(normalizeRawSegment({ start, end, phoneme, raw: line }));
  }
  return out;
}

function normalizeRawSegment(seg) {
  const start = seg.start ?? seg.begin ?? seg.t0;
  const end = seg.end ?? seg.finish ?? seg.t1;
  const phoneme = seg.phoneme ?? seg.phone ?? seg.label ?? seg.text;
  return {
    start: start === undefined ? NaN : Number(start),
    end: end === undefined ? NaN : Number(end),
    phoneme: phoneme === undefined || phoneme === null ? '' : String(phoneme),
    raw: seg.raw,
  };
}

// 校验、排序、修复重叠，返回 { segments, issues }
export function normalizeSegments(rawSegments) {
  const issues = [];
  const segs = [];
  for (const raw of rawSegments) {
    if (raw._bad) {
      issues.push({ level: 'error', code: 'bad_line', message: `无法解析的标注行: ${raw.raw ?? ''}`, detail: raw.reason });
      continue;
    }
    if (!Number.isFinite(raw.start) || !Number.isFinite(raw.end)) {
      issues.push({ level: 'error', code: 'bad_time', message: `音素 "${raw.phoneme}" 缺少合法的起止时间`, at: raw });
      continue;
    }
    if (raw.end <= raw.start + EPS) {
      issues.push({ level: 'error', code: 'non_positive_duration', message: `音素 "${raw.phoneme}" 时长非正（${round6(raw.start)}→${round6(raw.end)}），已丢弃`, at: raw });
      continue;
    }
    if (!raw.phoneme.trim()) {
      issues.push({ level: 'error', code: 'empty_phoneme', message: `${round6(raw.start)}→${round6(raw.end)} 存在空音素，已丢弃`, at: raw });
      continue;
    }
    segs.push({ start: raw.start, end: raw.end, phoneme: raw.phoneme.trim() });
  }

  segs.sort((a, b) => a.start - b.start || a.end - b.end);

  // 修复重叠
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1];
    const cur = segs[i];
    if (cur.start < prev.end - EPS) {
      issues.push({
        level: 'warn', code: 'overlap',
        message: `音素 "${cur.phoneme}" 与 "${prev.phoneme}" 时间重叠，起点已对齐到 ${round6(prev.end)}s`,
        detail: { phoneme: cur.phoneme, from: round6(cur.start), to: round6(prev.end) },
      });
      cur.start = prev.end;
      if (cur.end <= cur.start + EPS) {
        issues.push({ level: 'error', code: 'zero_after_overlap', message: `音素 "${cur.phoneme}" 修复重叠后时长非正，已丢弃` });
        segs.splice(i, 1);
        i--;
      }
    }
  }

  // 标注内部未覆盖的空隙
  for (let i = 1; i < segs.length; i++) {
    const gap = segs[i].start - segs[i - 1].end;
    if (gap > 1e-3) {
      issues.push({
        level: 'warn', code: 'uncovered_gap',
        message: `${round6(segs[i - 1].end)}s→${round6(segs[i].start)}s 存在 ${round6(gap)}s 未标注空隙，按静默中性姿态处理`,
      });
    }
  }
  return { segments: segs, issues };
}

// ---------------------------------------------------------------------------
// 模型形态绑定：抽象通道 -> 模型实际 morph（含替代/缺失报告）
// ---------------------------------------------------------------------------

export function resolveModel(modelDef, abstractChannels = ABSTRACT_CHANNELS) {
  const morphs = new Set(modelDef.morphs);
  const bindings = {}; // abstractCh -> { morph, scale, mode: 'direct'|'substitute' }
  const report = {
    modelId: modelDef.id,
    direct: [], substitutes: [], dropped: [],
    issues: [],
  };

  const resolveOne = (ch) => {
    const direct = modelDef.mapping?.[ch];
    if (direct && morphs.has(direct)) {
      bindings[ch] = { morph: direct, scale: 1, mode: 'direct' };
      report.direct.push({ channel: ch, morph: direct });
      return;
    }
    const sub = modelDef.substitutes?.[ch];
    if (sub) {
      const targetCh = sub.to;
      const targetMorph = modelDef.mapping?.[targetCh];
      if (targetMorph && morphs.has(targetMorph)) {
        bindings[ch] = { morph: targetMorph, scale: sub.scale ?? 0.5, mode: 'substitute' };
        report.substitutes.push({ channel: ch, morph: targetMorph, reason: sub.reason, scale: sub.scale ?? 0.5 });
        report.issues.push({
          level: 'warn', code: 'substitute',
          message: `抽象形态 "${ch}" 在模型 "${modelDef.id}" 中缺失，使用可解释替代 → 实际形态 "${targetMorph}"（系数 ${sub.scale ?? 0.5}）`,
          detail: { channel: ch, substituteMorph: targetMorph, reason: sub.reason },
        });
        return;
      }
    }
    delete bindings[ch];
    report.dropped.push(ch);
    report.issues.push({
      level: 'error', code: 'missing_morph',
      message: `抽象形态 "${ch}" 在模型 "${modelDef.id}" 中既无对应形态也无替代方案，该通道权重不会输出`,
      detail: { channel: ch },
    });
  };

  for (const ch of abstractChannels) resolveOne(ch);
  return { bindings, report };
}

// ---------------------------------------------------------------------------
// 时间线构建：音素 -> viseme 事件（带过渡包络与闭口保持）
// ---------------------------------------------------------------------------

export function buildTimeline(rawSegments, options = {}) {
  const {
    phonemeMap = DEFAULT_PHONEME_MAP,
    visemeTargets = VISEME_TARGETS,
    transition = DEFAULT_TRANSITION,
    model = null,
    channelRanges = CHANNEL_RANGES,
    channelCombine = CHANNEL_COMBINE,
  } = options;

  const { segments, issues: normIssues } = normalizeSegments(rawSegments);
  const issues = [...normIssues];
  const modelResolution = model
    ? resolveModel(model)
    : { bindings: Object.fromEntries(ABSTRACT_CHANNELS.map((c) => [c, { morph: c, scale: 1, mode: 'direct' }])), report: { modelId: 'abstract', direct: ABSTRACT_CHANNELS.map((c) => ({ channel: c, morph: c })), substitutes: [], dropped: [], issues: [] } };
  issues.push(...modelResolution.report.issues);

  const events = [];
  const pauses = [];
  let closureEnforcedCount = 0;

  for (const seg of segments) {
    const key = seg.phoneme.toLowerCase();
    const visemeId = phonemeMap[key];
    if (visemeId === undefined) {
      issues.push({
        level: 'error', code: 'unknown_phoneme',
        message: `音素 "${seg.phoneme}"（${round6(seg.start)}s）在映射表中没有对应口型，该段不产生口型驱动`,
        detail: { phoneme: seg.phoneme, start: round6(seg.start), end: round6(seg.end) },
      });
      continue;
    }
    const target = visemeTargets[visemeId];
    if (!target) {
      issues.push({
        level: 'error', code: 'unknown_viseme',
        message: `口型 "${visemeId}"（来自音素 "${seg.phoneme}"）没有形态目标定义`,
      });
      continue;
    }

    const isSilence = visemeId === SIL || target.relaxed === true;
    const isInterior = seg.start > EPS && seg.end < durationOf(segments) - EPS;
    if (isSilence) {
      const dur = seg.end - seg.start;
      if (isInterior && dur >= transition.pauseThreshold) {
        pauses.push({ start: round6(seg.start), end: round6(seg.end), duration: round6(dur), long: true });
        issues.push({
          level: 'info', code: 'long_pause',
          message: `检测到长停顿 ${round6(seg.start)}s→${round6(seg.end)}s（${round6(dur)}s），期间保持中性静默姿态、不随音量张嘴`,
        });
      }
    }

    const isClosure = target.closure === true;
    const attack = Math.min(transition.attack, transition.transitionMaxSpan);
    const release = Math.min(transition.release, transition.transitionMaxSpan);

    let riseStart;
    let riseEnd;
    let fallStart;
    let fallEnd;
    let enforced = false;

    if (isClosure) {
      // 闭口辅音：在音素末端达到完全闭合，并保证最小闭合保持，
      // 防止被相邻元音的加权平均稀释。
      const segDur = seg.end - seg.start;
      if (segDur < transition.closureHold) {
        enforced = true;
        closureEnforcedCount += 1;
      }
      const plateauStart = Math.min(seg.start, seg.end - transition.closureHold);
      riseStart = plateauStart - attack;
      riseEnd = plateauStart;
      fallStart = seg.end;
      fallEnd = seg.end + release;
    } else {
      riseStart = seg.start - attack;
      riseEnd = seg.start;
      fallStart = seg.end;
      fallEnd = seg.end + release;
    }

    if (enforced) {
      issues.push({
        level: 'info', code: 'closure_hold',
        message: `闭口辅音 "${seg.phoneme}"（${round6(seg.start)}s→${round6(seg.end)}s）短于最小保持 ${transition.closureHold}s，已强制闭合保持`,
        detail: { phoneme: seg.phoneme, at: round6(seg.end) },
      });
    }

    events.push({
      phoneme: seg.phoneme,
      visemeId,
      start: seg.start,
      end: seg.end,
      riseStart, riseEnd, fallStart, fallEnd,
      target,
      closure: isClosure,
      relaxed: isSilence,
    });
  }

  const duration = segments.length ? segments[segments.length - 1].end : 0;

  return {
    duration: round6(duration),
    segments,
    events,
    pauses,
    issues,
    modelResolution,
    channelRanges,
    channelCombine,
    stats: {
      phonemeCount: segments.length,
      eventCount: events.length,
      closureEvents: events.filter((e) => e.closure).length,
      closureEnforcedCount,
      longPauseCount: pauses.length,
      errorCount: issues.filter((i) => i.level === 'error').length,
      warnCount: issues.filter((i) => i.level === 'warn').length,
    },
  };
}

function eventWeight(ev, t) {
  if (t < ev.riseStart - EPS || t > ev.fallEnd + EPS) return 0;
  if (t < ev.riseEnd) return smoothstep(ev.riseStart, ev.riseEnd, t);
  if (t <= ev.fallStart) return 1;
  return 1 - smoothstep(ev.fallStart, ev.fallEnd, t);
}

// 抽象通道权重（无模型时的输出）
export function sampleAbstract(timeline, t) {
  const out = {};
  const active = [];
  let closurePressure = 0; // 当前时刻所有闭口事件的最大闭合强度
  for (const ev of timeline.events) {
    const w = eventWeight(ev, t);
    if (w > EPS) {
      active.push({ ev, w });
      if (ev.closure) closurePressure = Math.max(closurePressure, w);
    }
  }
  for (const ch of ABSTRACT_CHANNELS) {
    const range = timeline.channelRanges[ch] || { min: 0, max: 1 };
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
    // 闭口辅音对张嘴通道有硬性抑制：嘴唇闭合时不允许下颌保持张开姿态
    if (ch === 'jawOpen' && closurePressure > 0) {
      value *= (1 - 0.85 * closurePressure);
    }
    out[ch] = Math.min(range.max, Math.max(range.min, value));
  }
  return out;
}

// 绑定到模型实际 morph 名称
export function bindToMorphs(timeline, abstractWeights) {
  const { bindings } = timeline.modelResolution;
  const morphs = {};
  for (const [ch, weight] of Object.entries(abstractWeights)) {
    const b = bindings[ch];
    if (!b) continue; // 缺失且无替代：显式不输出
    const range = timeline.channelRanges[ch] || { min: 0, max: 1 };
    const scaled = weight * b.scale;
    morphs[b.morph] = Math.min(range.max, Math.max(range.min, (morphs[b.morph] || 0) + scaled));
  }
  return morphs;
}

// 主求值接口：给定媒体时钟时间 t，返回该时刻的完整口型状态。
export function sampleAt(timeline, t) {
  const inRange = t >= -EPS && t <= timeline.duration + EPS;
  const tt = Math.max(0, Math.min(t, timeline.duration));
  const abstract = sampleAbstract(timeline, tt);
  const morphs = bindToMorphs(timeline, abstract);
  return { t: round6(t), inRange, abstract, morphs };
}

// 确定性网格采样：t_k = k*dt（先取整再乘法，避免浮点漂移），等距、可复现。
export function sampleGrid(timeline, dt = 0.01) {
  if (!(dt > 0)) throw new Error('采样步长 dt 必须为正数');
  const n = Math.floor(timeline.duration / dt + 1e-9) + 1;
  const samples = new Array(n);
  for (let k = 0; k < n; k++) {
    const t = round6(Math.round(k * dt * 1e6) / 1e6);
    samples[k] = sampleAt(timeline, t);
  }
  return { dt, count: n, duration: timeline.duration, samples };
}

// ---------------------------------------------------------------------------
// 关键闭合时刻核对：期望 vs 实际，形成“误差记录”
// ---------------------------------------------------------------------------

export function closureAudit(timeline, threshold = 0.9) {
  const records = [];
  for (const ev of timeline.events) {
    if (!ev.closure) continue;
    const peakT = ev.end; // 闭口峰值在音素末端
    const sample = sampleAt(timeline, peakT);
    const expected = ev.target.lipClose || 0;
    const achievedAbstract = sample.abstract.lipClose;
    const binding = timeline.modelResolution.bindings.lipClose;
    const achievedMorph = binding ? sample.morphs[binding.morph] ?? 0 : 0;
    const pass = binding ? achievedMorph >= expected * threshold : achievedAbstract >= expected * threshold;
    records.push({
      phoneme: ev.phoneme,
      viseme: ev.visemeId,
      time: round6(peakT),
      expectedLipClose: expected,
      achievedAbstract: round6(achievedAbstract),
      morph: binding ? binding.morph : null,
      achievedMorph: binding ? round6(achievedMorph) : null,
      threshold,
      pass: binding ? pass : achievedAbstract >= expected * threshold,
      note: binding ? '' : '模型无 lipClose 形态，仅记录抽象通道值',
    });
  }
  return records;
}

// 完整导出载荷（权重曲线 + 误差/问题记录）
export function buildExportPayload(timeline, dt = 0.01) {
  const grid = sampleGrid(timeline, dt);
  return {
    format: 'viseme-weights-v1',
    generatedAtDeterministic: true,
    sampleStepSec: dt,
    duration: timeline.duration,
    model: {
      id: timeline.modelResolution.report.modelId,
      bindings: timeline.modelResolution.bindings,
      dropped: timeline.modelResolution.report.dropped,
      substitutes: timeline.modelResolution.report.substitutes,
    },
    samples: grid.samples.map((s) => ({
      t: s.t,
      abstract: roundObj(s.abstract),
      morphs: roundObj(s.morphs),
    })),
    closureAudit: closureAudit(timeline),
    pauses: timeline.pauses,
    issues: timeline.issues,
    stats: timeline.stats,
  };
}

function roundObj(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = round6(v);
  return out;
}
