// Процедурный звук на WebAudio: вой ветра и хруст снега под ногами.
// Никаких внешних ассетов — всё синтезируется из шума.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.windLevel = 0.5; // 0..1 — сила порыва, читается визуальной частью
  }

  init() {
    if (this.ctx) return;
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    // общий буфер белого шума
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    this._buildWind();
    this._scheduleGust();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // ---------- ветер ----------
  _buildWind() {
    const ctx = this.ctx;
    this.windBus = ctx.createGain();
    this.windBus.gain.value = 0.5;
    const windMaster = ctx.createGain();
    windMaster.gain.value = 0.4;
    this.windBus.connect(windMaster);
    windMaster.connect(this.master);

    // слой: шум -> полосовой фильтр (LFO по частоте) -> гейн (LFO) -> панорама
    const layer = (freq, q, gain, pan, lfoRate, lfoDepth) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = freq;
      bp.Q.value = q;

      const g = ctx.createGain();
      g.gain.value = gain;

      const p = ctx.createStereoPanner();
      p.pan.value = pan;

      const lfoF = ctx.createOscillator();
      lfoF.frequency.value = lfoRate;
      const lfoFGain = ctx.createGain();
      lfoFGain.gain.value = lfoDepth;
      lfoF.connect(lfoFGain);
      lfoFGain.connect(bp.frequency);

      const lfoA = ctx.createOscillator();
      lfoA.frequency.value = lfoRate * 0.63 + 0.011;
      const lfoAGain = ctx.createGain();
      lfoAGain.gain.value = gain * 0.55;
      lfoA.connect(lfoAGain);
      lfoAGain.connect(g.gain);

      src.connect(bp);
      bp.connect(g);
      g.connect(p);
      p.connect(this.windBus);
      src.start();
      lfoF.start();
      lfoA.start();
    };

    // низкий гул, средний шелест и два воющих свиста с высоким Q
    layer(170, 0.6, 0.55, -0.35, 0.06, 55);
    layer(340, 1.2, 0.32, 0.35, 0.045, 120);
    layer(560, 11, 0.055, -0.12, 0.021, 210);
    layer(880, 15, 0.032, 0.18, 0.016, 320);
  }

  _scheduleGust() {
    const tick = () => {
      if (this.ctx) {
        const target = 0.3 + Math.random() * 0.7;
        this.windLevel = target;
        this.windBus.gain.setTargetAtTime(0.25 + target * 0.75, this.ctx.currentTime, 1.8);
      }
      setTimeout(tick, 3500 + Math.random() * 5500);
    };
    tick();
  }

  // ---------- дыхание ----------
  breath(exertion) {
    if (!this.ctx || exertion < 0.45) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.5;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 500 + Math.random() * 250;
    bp.Q.value = 1.1;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1300;

    const g = ctx.createGain();
    const peak = 0.03 + (exertion - 0.45) * 0.16;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.22);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);

    src.connect(bp);
    bp.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 1.2, 0.8);
  }

  // ---------- хруст снега ----------
  footstep(running) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;

    const out = ctx.createGain();
    out.gain.value = (running ? 0.5 : 0.32) * (0.85 + Math.random() * 0.3);
    out.connect(this.master);

    // хруст — серия шумовых «зёрен»: удар пятки + дробное сминание наста
    const grains = 6 + ((Math.random() * 4) | 0);
    const spread = running ? 0.011 : 0.017;
    for (let i = 0; i < grains; i++) {
      const st = t + (i === 0 ? 0 : i * spread + Math.random() * 0.008);
      const dur = 0.02 + Math.random() * 0.03;

      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.6 + Math.random() * 0.9;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 220;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = (running ? 1500 : 1050) + Math.random() * 900;
      lp.Q.value = 0.8;

      const g = ctx.createGain();
      const peak = (i === 0 ? 1.0 : 0.62 * Math.pow(0.82, i)) * (0.7 + Math.random() * 0.5);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(peak, st + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur + 0.045);

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(out);
      src.start(st, Math.random() * 1.5, dur + 0.1);
    }

    // низкий «бух» — вес шага
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(running ? 95 : 80, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(running ? 0.34 : 0.2, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.15);
  }
}
