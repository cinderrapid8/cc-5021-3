// 确定性离线音频合成：仅用于内置演示样例。
// 真实使用时由用户加载自制语音；口型永远由音素标注时间驱动，与音量解耦。

import { sampleAt } from './engine.js';

const VOWEL_PARAMS = {
  a:  { f0: 130, formants: [730, 1090, 2440], gain: 0.55 },
  i:  { f0: 145, formants: [270, 2290, 3010], gain: 0.45 },
  u:  { f0: 120, formants: [300, 870, 2240], gain: 0.45 },
  o:  { f0: 125, formants: [570, 840, 2410], gain: 0.50 },
  e:  { f0: 140, formants: [530, 1840, 2480], gain: 0.45 },
  V_er: { f0: 135, formants: [490, 1350, 1690], gain: 0.4 },
  V_yu: { f0: 145, formants: [300, 1900, 2300], gain: 0.4 },
};

function visemeToVowel(visemeId) {
  const table = { A: 'a', I: 'i', U: 'u', O: 'o', E: 'e', V_er: 'V_er', V_yu: 'V_yu' };
  return table[visemeId] || null;
}

// 按标注段生成单声道 PCM Float32 数据
export function synthPcm(schedule, sampleRate = 22050) {
  const total = Math.ceil(schedule.duration * sampleRate);
  const pcm = new Float32Array(total);
  const twoPi = 2 * Math.PI;

  for (const seg of schedule.segments) {
    const i0 = Math.round(seg.start * sampleRate);
    const i1 = Math.round(seg.end * sampleRate);
    const key = seg.phoneme.toLowerCase();
    const isSilence = ['sil', 'sp', 'pau', 'br', 'breath', '#'].includes(key);

    if (isSilence) {
      // 静默段：仅极轻底噪，保证“停顿不张嘴”可被直观核对
      for (let i = i0; i < i1 && i < total; i++) {
        pcm[i] = (pseudoNoise(i) - 0.5) * 0.004;
      }
      continue;
    }

    if (['b', 'p', 'm'].includes(key)) {
      // 双唇闭塞：前 60% 近静音（对应闭唇），末端轻微爆破
      const closeEnd = i0 + Math.floor((i1 - i0) * 0.6);
      for (let i = i0; i < closeEnd && i < total; i++) pcm[i] = (pseudoNoise(i) - 0.5) * 0.003;
      for (let i = closeEnd; i < i1 && i < total; i++) {
        const u = (i - closeEnd) / Math.max(1, i1 - closeEnd);
        pcm[i] = (pseudoNoise(i) - 0.5) * 0.18 * Math.sin(Math.PI * u);
      }
      continue;
    }

    if (['f', 'v'].includes(key)) {
      for (let i = i0; i < i1 && i < total; i++) {
        const u = (i - i0) / Math.max(1, i1 - i0);
        pcm[i] = (pseudoNoise(i * 7 + 3) - 0.5) * 0.12 * Math.sin(Math.PI * u);
      }
      continue;
    }

    if (['d', 't', 'g', 'k', 's', 'z', 'c', 'sh', 'zh', 'ch', 'h', 'x', 'j', 'q', 'n', 'l', 'r'].includes(key)) {
      for (let i = i0; i < i1 && i < total; i++) {
        const u = (i - i0) / Math.max(1, i1 - i0);
        pcm[i] = (pseudoNoise(i * 13 + 11) - 0.5) * 0.08 * Math.sin(Math.PI * u);
      }
      continue;
    }

    // 元音：基频 + 三个共振峰，带起音/收音包络
    const viseme = schedule.visemeLookup ? schedule.visemeLookup(key) : null;
    const vowel = visemeToVowel(viseme);
    const params = vowel ? VOWEL_PARAMS[vowel] : VOWEL_PARAMS.a;
    const ramp = Math.min(0.02, (seg.end - seg.start) * 0.25);
    for (let i = i0; i < i1 && i < total; i++) {
      const t = i / sampleRate;
      const u = (i - i0) / Math.max(1, i1 - i0);
      let env = 1;
      const attackSamples = Math.floor(ramp * sampleRate);
      if (i - i0 < attackSamples) env = (i - i0) / attackSamples;
      if (i1 - i < attackSamples) env = Math.min(env, (i1 - i) / attackSamples);
      let sample = 0;
      sample += Math.sin(twoPi * params.f0 * t);
      for (const f of params.formants) sample += 0.35 * Math.sin(twoPi * f * t);
      pcm[i] = sample / 2.05 * params.gain * env;
    }
  }

  // 防止段边界爆音：做一次极短交叉淡入处理（3ms）
  const cross = Math.floor(sampleRate * 0.003);
  for (const seg of schedule.segments.slice(1)) {
    const boundary = Math.round(seg.start * sampleRate);
    for (let i = Math.max(1, boundary - cross); i < boundary && i < total; i++) {
      const u = (i - (boundary - cross)) / cross;
      pcm[i] *= 0.5 + 0.5 * u;
    }
  }
  return pcm;
}

// 确定性伪随机噪声（保证同样标注每次生成相同音频）
function pseudoNoise(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

export function encodeWav(pcm, sampleRate) {
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// 由样例计划（含 segments）生成可直接赋给 <audio> 的 Blob URL
export function synthSampleBlob(scheduleDef, phonemeMap, sampleRate = 22050) {
  const duration = scheduleDef.segments[scheduleDef.segments.length - 1].end;
  const schedule = {
    duration,
    segments: scheduleDef.segments,
    visemeLookup: (key) => phonemeMap[key] ?? null,
  };
  const pcm = synthPcm(schedule, sampleRate);
  return encodeWav(pcm, sampleRate);
}

// 离线峰值包络（用于波形对照显示），同样不参与口型驱动
export function computePeaks(pcm, buckets = 600) {
  const peaks = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(pcm.length / buckets));
  for (let b = 0; b < buckets; b++) {
    let peak = 0;
    const end = Math.min(pcm.length, (b + 1) * per);
    for (let i = b * per; i < end; i++) {
      const v = Math.abs(pcm[i]);
      if (v > peak) peak = v;
    }
    peaks[b] = peak;
  }
  return peaks;
}

export { sampleAt };
