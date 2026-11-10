// 媒体时钟。
// 播放时口型求值的唯一依据是媒体时钟时间，requestAnimationFrame 只负责“取时间并重绘”，
// 绝不累计帧数或自行累加 dt，因此拖动、变速（playbackRate）、暂停恢复都不会产生偏差。

// 纯函数的确定性时钟状态机：给定经过的墙钟时间，推进媒体时间。
// 供离线测试与确定性时间采样核对；浏览器播放路径直接使用媒体元素的时钟。
export class SimulationClock {
  constructor() {
    this.mediaTime = 0;
    this.rate = 1;
    this.playing = false;
    this.lastWall = null;
  }

  update(wallTime) {
    if (this.lastWall === null) this.lastWall = wallTime;
    const elapsed = wallTime - this.lastWall;
    this.lastWall = wallTime;
    if (this.playing) this.mediaTime += elapsed * this.rate;
    if (this.mediaTime < 0) this.mediaTime = 0;
    return this.mediaTime;
  }

  play(wallTime) { this.playing = true; this.lastWall = wallTime; }
  pause() { this.playing = false; }
  seek(time) {
    this.mediaTime = Math.max(0, time);
    this.lastWall = null;
    return this.mediaTime;
  }
  setRate(rate) {
    if (!(rate > 0)) throw new Error('播放速率必须为正数');
    this.rate = rate;
    this.lastWall = null;
  }
  getTime() { return this.mediaTime; }
}

// 浏览器媒体时钟：所有时间查询都转发给媒体元素，不维护自己的累计量。
export class MediaClock {
  constructor(mediaElement) {
    if (!mediaElement) throw new Error('MediaClock 需要一个媒体元素');
    this.media = mediaElement;
  }

  // 求值依据：媒体元素自身的播放位置（拖动/变速/暂停由浏览器保证正确）
  getTime() { return this.media.currentTime; }
  get duration() { return Number.isFinite(this.media.duration) ? this.media.duration : 0; }
  get rate() { return this.media.playbackRate; }
  get paused() { return this.media.paused; }

  seek(time) {
    const t = Math.max(0, Math.min(time, this.duration || time));
    this.media.currentTime = t; // 直接移动媒体时钟，不做任何帧补偿
    return t;
  }

  setRate(rate) {
    if (!(rate > 0)) throw new Error('播放速率必须为正数');
    this.media.playbackRate = rate;
  }

  play() { return this.media.play(); }
  pause() { this.media.pause(); }

  // 帧循环：只取当前媒体时间并回调；没有媒体时间推进就不会有口型变化
  startFrameLoop(onTick) {
    let rafId = 0;
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      onTick(this.getTime());
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(rafId);
    };
  }
}
