#!/usr/bin/env python3
"""生成内置演示样例的可播放 WAV 与音素时间标注 JSON。

仅依赖标准库；同样的计划每次生成字节一致的资产。
口型曲线由标注时间驱动，音频里的音量变化不参与嘴部求值。
"""
import json
import math
import os
import struct
import wave

SR = 22050

# 与 src/config.js 的 SAMPLE_SCHEDULES 保持一致
SCHEDULES = {
    "short_vowels": [
        (0.000, 0.280, "sil"),
        (0.280, 0.360, "b"),
        (0.360, 0.560, "a"),
        (0.620, 0.700, "b"),
        (0.700, 0.880, "i"),
        (0.940, 1.020, "b"),
        (1.020, 1.220, "u"),
        (1.220, 1.600, "sil"),
    ],
    "fast_syllables": [
        (0.000, 0.150, "sil"),
        (0.150, 0.205, "b"),
        (0.205, 0.305, "a"),
        (0.305, 0.360, "d"),
        (0.360, 0.455, "a"),
        (0.455, 0.515, "g"),
        (0.515, 0.620, "a"),
        (0.620, 0.675, "b"),
        (0.675, 0.770, "a"),
        (0.770, 0.825, "d"),
        (0.825, 0.920, "a"),
        (0.920, 0.980, "g"),
        (0.980, 1.085, "a"),
        (1.085, 1.400, "sil"),
    ],
    "long_pause": [
        (0.000, 0.250, "sil"),
        (0.250, 0.330, "b"),
        (0.330, 0.550, "a"),
        (0.550, 1.450, "sil"),
        (1.450, 1.530, "b"),
        (1.530, 1.750, "i"),
        (1.750, 2.000, "sil"),
    ],
}

VOWELS = {
    "a": (130, (730, 1090, 2440), 0.55),
    "i": (145, (270, 2290, 3010), 0.45),
    "u": (120, (300, 870, 2240), 0.45),
    "e": (140, (530, 1840, 2480), 0.45),
    "o": (125, (570, 840, 2410), 0.50),
}
CONSONANTS_NOISE = {"d", "t", "g", "k", "s", "z", "c", "sh", "zh", "ch", "h", "x", "j", "q", "n", "l", "r"}
SILENCES = {"sil", "sp", "pau", "br", "breath", "#"}


def noise(n):
    x = math.sin(n * 12.9898) * 43758.5453
    return x - math.floor(x) - 0.5


def synth(schedule):
    duration = schedule[-1][1]
    total = int(round(duration * SR))
    pcm = [0.0] * total
    two_pi = 2 * math.pi

    for start, end, ph in schedule:
        i0, i1 = int(round(start * SR)), int(round(end * SR))
        key = ph.lower()
        if key in SILENCES:
            for i in range(i0, min(i1, total)):
                pcm[i] = noise(i) * 0.004
        elif key in ("b", "p", "m"):
            close_end = i0 + int((i1 - i0) * 0.6)
            for i in range(i0, min(close_end, total)):
                pcm[i] = noise(i) * 0.003
            for i in range(close_end, min(i1, total)):
                u = (i - close_end) / max(1, i1 - close_end)
                pcm[i] = noise(i) * 0.18 * math.sin(math.pi * u)
        elif key in ("f", "v"):
            for i in range(i0, min(i1, total)):
                u = (i - i0) / max(1, i1 - i0)
                pcm[i] = noise(i * 7 + 3) * 0.12 * math.sin(math.pi * u)
        elif key in CONSONANTS_NOISE:
            for i in range(i0, min(i1, total)):
                u = (i - i0) / max(1, i1 - i0)
                pcm[i] = noise(i * 13 + 11) * 0.08 * math.sin(math.pi * u)
        else:
            f0, formants, gain = VOWELS.get(key, VOWELS["a"])
            ramp = min(0.02, (end - start) * 0.25)
            attack = max(1, int(ramp * SR))
            for i in range(i0, min(i1, total)):
                t = i / SR
                env = 1.0
                if i - i0 < attack:
                    env = (i - i0) / attack
                if i1 - i < attack:
                    env = min(env, (i1 - i) / attack)
                s = math.sin(two_pi * f0 * t)
                for f in formants:
                    s += 0.35 * math.sin(two_pi * f * t)
                pcm[i] = s / 2.05 * gain * env

    cross = int(SR * 0.003)
    for start, _end, _ph in schedule[1:]:
        boundary = int(round(start * SR))
        for i in range(max(1, boundary - cross), min(boundary, total)):
            u = (i - (boundary - cross)) / cross
            pcm[i] *= 0.5 + 0.5 * u
    return pcm


def write_wav(path, pcm):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = bytearray()
        for s in pcm:
            s = max(-1.0, min(1.0, s))
            frames += struct.pack("<h", int(s * 0x8000) if s < 0 else int(s * 0x7fff))
        w.writeframes(bytes(frames))


def main():
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "samples")
    os.makedirs(out_dir, exist_ok=True)
    for name, schedule in SCHEDULES.items():
        pcm = synth(schedule)
        wav_path = os.path.join(out_dir, f"{name}.wav")
        json_path = os.path.join(out_dir, f"{name}.json")
        write_wav(wav_path, pcm)
        payload = {
            "format": "phoneme-annotation-v1",
            "sampleRate": SR,
            "duration": schedule[-1][1],
            "segments": [
                {"start": round(s, 3), "end": round(e, 3), "phoneme": p}
                for s, e, p in schedule
            ],
        }
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        print(f"wrote {wav_path} ({len(pcm)} samples) and {json_path}")


if __name__ == "__main__":
    main()
