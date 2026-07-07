// Процедурный звук на WebAudio: вой ветра, хруст снега, костёр, дыхание.
// Никаких внешних ассетов — всё синтезируется из шума.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
    this._buildCampfire();
  }

  // ---------- костёр ----------
  _buildCampfire() {
    const ctx = this.ctx;
    this.firePan = ctx.createStereoPanner();
    this.fireBus = ctx.createGain();
    this.fireBus.gain.value = 0;
    // лоупас: костёр снаружи слышен из домика глухо
    this.fireLP = ctx.createBiquadFilter();
    this.fireLP.type = 'lowpass';
    this.fireLP.frequency.value = 20000;
    this.fireBus.connect(this.firePan);
    this.firePan.connect(this.fireLP);
    this.fireLP.connect(this.master);

    // шипение и низкий гул пламени
    const hiss = ctx.createBufferSource();
    hiss.buffer = this.noise;
    hiss.loop = true;
    const hlp = ctx.createBiquadFilter();
    hlp.type = 'lowpass';
    hlp.frequency.value = 480;
    const hg = ctx.createGain();
    hg.gain.value = 0.22;
    const hLfo = ctx.createOscillator();
    hLfo.frequency.value = 7.3;
    const hLfoG = ctx.createGain();
    hLfoG.gain.value = 0.06;
    hLfo.connect(hLfoG);
    hLfoG.connect(hg.gain);
    hiss.connect(hlp);
    hlp.connect(hg);
    hg.connect(this.fireBus);
    hiss.start();
    hLfo.start();

    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise;
    rumble.loop = true;
    rumble.playbackRate.value = 0.5;
    const rlp = ctx.createBiquadFilter();
    rlp.type = 'lowpass';
    rlp.frequency.value = 130;
    const rg = ctx.createGain();
    rg.gain.value = 0.35;
    rumble.connect(rlp);
    rlp.connect(rg);
    rg.connect(this.fireBus);
    rumble.start();

    // треск — случайные щелчки
    const crackle = () => {
      if (!this.ctx) return;
      const t = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 1 + Math.random();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1200 + Math.random() * 2600;
      const g = ctx.createGain();
      const dur = 0.008 + Math.random() * 0.025;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.12 + Math.random() * 0.4, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
      src.connect(hp);
      hp.connect(g);
      g.connect(this.fireBus);
      src.start(t, Math.random() * 1.5, dur + 0.05);
      setTimeout(crackle, 60 + Math.random() * 320);
    };
    crackle();
  }

  // громкость/панорама костра по позиции игрока (звать каждый кадр)
  updateCampfire(dist, pan) {
    if (!this.ctx) return;
    const vol = 0.75 / (1 + (dist / 3.2) ** 2);
    this.fireBus.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.12);
    this.firePan.pan.setTargetAtTime(clamp(pan, -0.85, 0.85), this.ctx.currentTime, 0.12);
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // k: 0..1 — насколько игрок «внутри» (стены глушат ветер и костёр)
  setIndoor(k) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 20000 * Math.pow(340 / 20000, clamp(k, 0, 1)); // экспоненциальный спад частоты среза
    this.windLP.frequency.setTargetAtTime(f, t, 0.3);
    this.fireLP.frequency.setTargetAtTime(f, t, 0.3);
    this.windMaster.gain.setTargetAtTime(0.4 * (1 - 0.72 * k), t, 0.3);
  }

  // ---------- дверь: скрип петель + щеколда ----------
  door(open) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;

    const out = ctx.createGain();
    out.gain.value = 0.55;
    out.connect(this.master);

    // щёлчок щеколды: при открытии — сразу, при закрытии — в конце хода
    const ct = open ? t : t + 0.5;
    const click = ctx.createBufferSource();
    click.buffer = this.noise;
    const cbp = ctx.createBiquadFilter();
    cbp.type = 'bandpass';
    cbp.frequency.value = 2400 + Math.random() * 600;
    cbp.Q.value = 1.6;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, ct);
    cg.gain.linearRampToValueAtTime(0.32, ct + 0.003);
    cg.gain.exponentialRampToValueAtTime(0.0001, ct + 0.05);
    click.connect(cbp);
    cbp.connect(cg);
    cg.connect(out);
    click.start(ct, Math.random(), 0.08);

    // скрип петель: пила с шаткой частотой через узкий полосовой фильтр
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    const f0 = 130 + Math.random() * 70;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.linearRampToValueAtTime(f0 * (open ? 1.6 : 0.7), t + 0.42);
    const wob = ctx.createOscillator();
    wob.frequency.value = 10 + Math.random() * 5;
    const wg = ctx.createGain();
    wg.gain.value = 16;
    wob.connect(wg);
    wg.connect(o.frequency);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 820 + Math.random() * 260;
    bp.Q.value = 3.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.055, t + 0.09);
    g.gain.setValueAtTime(0.055, t + 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.52);
    o.connect(bp);
    bp.connect(g);
    g.connect(out);
    o.start(t);
    o.stop(t + 0.6);
    wob.start(t);
    wob.stop(t + 0.6);

    // при закрытии — глухой стук полотна о косяк
    if (!open) {
      const th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(120, t + 0.48);
      th.frequency.exponentialRampToValueAtTime(45, t + 0.56);
      const tg = ctx.createGain();
      tg.gain.setValueAtTime(0.0001, t + 0.48);
      tg.gain.linearRampToValueAtTime(0.4, t + 0.487);
      tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
      th.connect(tg);
      tg.connect(out);
      th.start(t + 0.48);
      th.stop(t + 0.62);
    }
  }

  // ---------- ветер ----------
  _buildWind() {
    const ctx = this.ctx;
    this.windBus = ctx.createGain();
    this.windBus.gain.value = 0.5;
    const windMaster = (this.windMaster = ctx.createGain());
    windMaster.gain.value = 0.4;
    // лоупас на выходе ветра: в домике стены глушат высокий свист
    this.windLP = ctx.createBiquadFilter();
    this.windLP.type = 'lowpass';
    this.windLP.frequency.value = 20000;
    this.windBus.connect(windMaster);
    windMaster.connect(this.windLP);
    this.windLP.connect(this.master);

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

  // ---------- шаги ----------
  footstep(running, surface = 'snow') {
    if (!this.ctx) return;
    if (surface === 'wood') return this._woodStep(running);
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

  // стук подошвы по половицам: удар пятки + резонанс доски + редкий скрип
  _woodStep(running) {
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;

    const out = ctx.createGain();
    out.gain.value = (running ? 0.5 : 0.34) * (0.85 + Math.random() * 0.3);
    out.connect(this.master);

    // глухой удар каблука
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 + Math.random() * 30, t);
    o.frequency.exponentialRampToValueAtTime(52, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(running ? 0.5 : 0.36, t + 0.005);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.16);

    // «стук» — короткий резонанс доски
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.9 + Math.random() * 0.4;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 300 + Math.random() * 280;
    bp.Q.value = 2.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 1.5, 0.12);

    // изредка половица поскрипывает под весом
    if (Math.random() < 0.16) {
      const st = t + 0.05 + Math.random() * 0.05;
      const so = ctx.createOscillator();
      so.type = 'sawtooth';
      const f0 = 90 + Math.random() * 60;
      so.frequency.setValueAtTime(f0, st);
      so.frequency.linearRampToValueAtTime(f0 * 1.35, st + 0.16);
      const sbp = ctx.createBiquadFilter();
      sbp.type = 'bandpass';
      sbp.frequency.value = 700 + Math.random() * 300;
      sbp.Q.value = 3.5;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(0.0001, st);
      sg.gain.linearRampToValueAtTime(0.03, st + 0.05);
      sg.gain.exponentialRampToValueAtTime(0.0001, st + 0.2);
      so.connect(sbp);
      sbp.connect(sg);
      sg.connect(out);
      so.start(st);
      so.stop(st + 0.24);
    }
  }

  // приземление после прыжка/падения: тяжёлый глухой удар обеих ног +
  // хруст наста (или стук досок). strength ≈ скорость касания.
  land(surface = 'snow', strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;

    const out = ctx.createGain();
    out.gain.value = clamp(0.5 + strength * 0.09, 0.5, 1.0);
    out.connect(this.master);

    // низкий «бум» веса
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(surface === 'wood' ? 138 : 90, t);
    o.frequency.exponentialRampToValueAtTime(33, t + 0.13);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.55, t + 0.008);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.19);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.22);

    // хруст/стук поверхности — короткая шумовая пачка
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = surface === 'wood' ? 1.0 : 0.7;
    const filt = ctx.createBiquadFilter();
    if (surface === 'wood') {
      filt.type = 'bandpass';
      filt.frequency.value = 320;
      filt.Q.value = 2.0;
    } else {
      filt.type = 'lowpass';
      filt.frequency.value = 1700;
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    src.connect(filt);
    filt.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 1.5, 0.17);
  }
}
