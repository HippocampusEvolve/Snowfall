// Процедурный звук на WebAudio: вой ветра, хруст снега, костёр, дыхание.
// Никаких внешних ассетов — всё синтезируется из шума.
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.windLevel = 0.5; // 0..1 — сила порыва, читается визуальной частью
    this.weatherPhase = 'calm'; // calm | build | storm | lull — длинная дуга метели
    this.cold = 0.2; // 0..1 — «злость» мороза: скрип шагов выше, деревья трещат
    this._indoorK = 0; // копия indoor: треск деревьев за стенами глуше
  }

  // температура воздуха (°C) → злость мороза. Мороз слышно, а не видно:
  // -8° и теплее — обычный хруст, к -22° шаги скрипят высоко и зло
  setTemperature(tC) {
    this.cold = clamp((-8 - tC) / 14, 0, 1);
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
    this._scheduleWeather();
    this._buildCampfire();
    this._scheduleTreeCrack();
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

  // громкость/панорама костра по позиции игрока (звать каждый кадр).
  // burn 0..1 — сила горения: угли еле шепчут, свежие дрова ревут
  updateCampfire(dist, pan, burn = 1) {
    if (!this.ctx) return;
    const vol = (0.75 / (1 + (dist / 3.2) ** 2)) * (0.12 + 0.88 * burn);
    this.fireBus.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.12);
    this.firePan.pan.setTargetAtTime(clamp(pan, -0.85, 0.85), this.ctx.currentTime, 0.12);
  }

  // взять полено с поленницы: глухой перестук дерева в руках
  woodTake() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < 2; i++) {
      const t = ctx.currentTime + 0.02 + i * (0.09 + Math.random() * 0.05);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.8 + Math.random() * 0.4;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 260 + Math.random() * 220;
      bp.Q.value = 2.6;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.4 - i * 0.14, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      src.start(t, Math.random() * 1.5, 0.12);
    }
  }

  // бросить полено: глухой тук дерева о землю + короткий хруст наста под ним
  woodDrop() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.01;

    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.master);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(44, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.35, t + 0.006);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.17);

    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t + 0.01);
    g.gain.linearRampToValueAtTime(0.28, t + 0.016);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    src.connect(lp);
    lp.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 1.5, 0.15);
  }

  // полено в огонь: глухой удар о угли + сноп искр (пачка тресков) + вздох пламени
  fireFeed() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.03;

    // удар полена о кострище
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.4, t + 0.007);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(og);
    og.connect(this.fireBus);
    o.start(t);
    o.stop(t + 0.2);

    // сноп искр — плотная пачка тресков
    for (let i = 0; i < 7; i++) {
      const st = t + 0.05 + Math.random() * 0.5;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 1 + Math.random();
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1400 + Math.random() * 2600;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(0.2 + Math.random() * 0.3, st + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.04);
      src.connect(hp);
      hp.connect(g);
      g.connect(this.fireBus);
      src.start(st, Math.random() * 1.5, 0.06);
    }

    // вздох занимающегося пламени
    const wh = ctx.createBufferSource();
    wh.buffer = this.noise;
    wh.loop = true;
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass';
    wlp.frequency.setValueAtTime(240, t);
    wlp.frequency.exponentialRampToValueAtTime(900, t + 0.5);
    wlp.frequency.exponentialRampToValueAtTime(300, t + 1.4);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.3, t + 0.35);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    wh.connect(wlp);
    wlp.connect(wg);
    wg.connect(this.fireBus);
    wh.start(t, Math.random());
    wh.stop(t + 1.6);
  }

  // ---------- лопата ----------
  // Врез штыка в снег: «шкрх» врезания + плотный хруст сминания (крупнее
  // шагового). Мороз (this.cold) сушит и повышает хруст — как и в шагах.
  // Звук мягкий и глухой: у снега нет резкой атаки, он проминается. Поэтому
  // атаки размяты (30–45 мс), «уф» не свипует по частоте (свип = «блуп»
  // пузыря), а весь врез идёт через общий лоупас, срезающий сухую верхушку.
  shovelDig() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const cold = this.cold;

    const out = ctx.createGain();
    out.gain.value = 0.34 + Math.random() * 0.08;
    // общий «войлок» поверх всего вреза: снег глушит верх
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = 1500 + cold * 600;
    soft.Q.value = 0.5;
    out.connect(soft);
    soft.connect(this.master);

    // врез: шумовая пачка с ниспадающим полосовым фильтром
    const cut = ctx.createBufferSource();
    cut.buffer = this.noise;
    cut.playbackRate.value = 0.7 + Math.random() * 0.4;
    const cbp = ctx.createBiquadFilter();
    cbp.type = 'bandpass';
    cbp.frequency.setValueAtTime(700 + cold * 250, t);
    cbp.frequency.exponentialRampToValueAtTime(300, t + 0.13);
    cbp.Q.value = 0.7;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.0001, t);
    cg.gain.linearRampToValueAtTime(0.5, t + 0.035);
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    cut.connect(cbp);
    cbp.connect(cg);
    cg.connect(out);
    cut.start(t, Math.random() * 1.5, 0.24);

    // хруст сминания — зёрна, как в шагах, но крупнее и дольше
    const grains = 7 + ((Math.random() * 4) | 0);
    for (let i = 0; i < grains; i++) {
      const st = t + 0.02 + i * 0.016 + Math.random() * 0.012;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.45 + Math.random() * 0.6 + cold * 0.25;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 520 + Math.random() * 500 + cold * 400;
      const g = ctx.createGain();
      const peak = 0.3 * Math.pow(0.87, i) * (0.7 + Math.random() * 0.5);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(peak, st + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.07);
      src.connect(lp);
      lp.connect(g);
      g.connect(out);
      src.start(st, Math.random() * 1.5, 0.1);
    }

    // вес нажима — низкий «уф». Без свипа частоты и с длинной атакой:
    // это придавливание, а не удар
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(58 + Math.random() * 8, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.22, t + 0.045);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.28);
  }

  // укладка снега: мягкий «шших» сброса + глухое похлопывание штыком
  shovelScoop() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;

    const out = ctx.createGain();
    out.gain.value = 0.42 + Math.random() * 0.1;
    out.connect(this.master);

    const wh = ctx.createBufferSource();
    wh.buffer = this.noise;
    wh.playbackRate.value = 0.6;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1300, t);
    lp.frequency.exponentialRampToValueAtTime(380, t + 0.22);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t);
    wg.gain.linearRampToValueAtTime(0.5, t + 0.03);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    wh.connect(lp);
    lp.connect(wg);
    wg.connect(out);
    wh.start(t, Math.random() * 1.5, 0.32);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(95, t + 0.1);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.1);
    og.gain.linearRampToValueAtTime(0.3, t + 0.11);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(og);
    og.connect(out);
    o.start(t + 0.1);
    o.stop(t + 0.27);
  }

  // промах: только свист штыка по воздуху
  shovelWhiff() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(500, t);
    bp.frequency.exponentialRampToValueAtTime(1400, t + 0.12);
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    src.start(t, Math.random() * 1.5, 0.22);
  }

  // взять лопату: деревянный перехват черенка + металлический тик штыка
  shovelTake() {
    if (!this.ctx) return;
    this.woodTake();
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.05;
    const tick = ctx.createBufferSource();
    tick.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 3100 + Math.random() * 600;
    bp.Q.value = 6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.12, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    tick.connect(bp);
    bp.connect(g);
    g.connect(this.master);
    tick.start(t, Math.random(), 0.11);
  }

  // воткнуть лопату: одиночный глубокий врез в наст
  shovelPlant() {
    if (!this.ctx) return;
    this.shovelDig();
  }

  // ---------- топор и рубка ----------
  // Удар топора в древесину: сухой звонкий «тюк» — резкая атака (у дерева,
  // в отличие от снега, она есть), деревянный корпус ствола и высокий тик
  // отскочившей щепы. Мороз делает стук ещё суше и звонче.
  axeChop() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const cold = this.cold;

    const out = ctx.createGain();
    out.gain.value = 0.5 + Math.random() * 0.1;
    out.connect(this.master);

    // сам «тюк»: узкая шумовая пачка с мгновенной атакой
    const hit = ctx.createBufferSource();
    hit.buffer = this.noise;
    hit.playbackRate.value = 0.9 + Math.random() * 0.3;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 950 + Math.random() * 350 + cold * 250;
    bp.Q.value = 1.1;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.0001, t);
    hg.gain.linearRampToValueAtTime(0.9, t + 0.002);
    hg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    hit.connect(bp);
    bp.connect(hg);
    hg.connect(out);
    hit.start(t, Math.random() * 1.5, 0.1);

    // корпус ствола: короткий деревянный бум
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(170 + Math.random() * 30, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(0.35, t + 0.004);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.14);

    // тик щепы
    const tick = ctx.createBufferSource();
    tick.buffer = this.noise;
    const thp = ctx.createBiquadFilter();
    thp.type = 'bandpass';
    thp.frequency.value = 2600 + Math.random() * 1400;
    thp.Q.value = 4;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t + 0.01);
    tg.gain.linearRampToValueAtTime(0.16, t + 0.013);
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
    tick.connect(thp);
    thp.connect(tg);
    tg.connect(out);
    tick.start(t + 0.01, Math.random(), 0.08);
  }

  // полено отделилось от ствола: раскалывающий треск волокон + тук о снег
  woodSplit() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    // серия быстрых щелчков рвущихся волокон
    for (let i = 0; i < 4; i++) {
      const st = ctx.currentTime + 0.01 + i * (0.018 + Math.random() * 0.02);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1300 + Math.random() * 1800;
      bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(0.3 - i * 0.05, st + 0.003);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.05);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      src.start(st, Math.random() * 1.5, 0.06);
    }
    // само полено падает рядом в снег
    setTimeout(() => this.woodDrop(), 160 + Math.random() * 120);
  }

  // скрип подрубленного ствола: stick-slip волокон — серия коротких скрипов,
  // учащающихся и растущих к моменту отрыва (dur — сколько дереву падать)
  treeCreak(dur = 2) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime + 0.02;
    let u = 0;
    let n = 0;
    while (u < dur * 0.82 && n < 26) {
      const st = t0 + u;
      const k = u / dur; // 0..~0.8 — как далеко зашёл накрен
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.5 + Math.random() * 0.25;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 240 + Math.random() * 160 - k * 90; // к отрыву — ниже, басовитее
      bp.Q.value = 7;
      const g = ctx.createGain();
      const peak = (0.1 + 0.5 * k) * (0.7 + Math.random() * 0.5);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(peak, st + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.09 + k * 0.1);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      src.start(st, Math.random() * 1.5, 0.25);
      u += 0.3 - 0.22 * k + Math.random() * 0.08; // скрипы всё чаще
      n++;
    }
  }

  // дерево рухнуло в сугроб: треск последних волокон, глубокий «ух» земли
  // и долгий выдох снежной пыли. dist — метры до комля: далёкое падение глуше
  treeFall(dist = 5) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const vol = 1 / (1 + (dist / 11) ** 2);

    const out = ctx.createGain();
    out.gain.value = 0.9 * vol;
    // дальнее падение — глуше: воздух и лес съедают верх
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 6000 / (1 + dist * 0.12);
    out.connect(lp);
    lp.connect(this.master);

    // треск разрыва комля — плотная пачка щелчков прямо перед ударом
    for (let i = 0; i < 6; i++) {
      const st = t + Math.random() * 0.12;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 700 + Math.random() * 1600;
      bp.Q.value = 2.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(0.35, st + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.07);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      src.start(st, Math.random() * 1.5, 0.09);
    }

    // «ух» — удар массы о землю
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(72, t + 0.1);
    o.frequency.exponentialRampToValueAtTime(26, t + 0.5);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.1);
    og.gain.linearRampToValueAtTime(0.8, t + 0.13);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.65);
    o.connect(og);
    og.connect(out);
    o.start(t + 0.1);
    o.stop(t + 0.7);

    // выдох снежной пыли — широкий шумовой хвост
    const wh = ctx.createBufferSource();
    wh.buffer = this.noise;
    wh.playbackRate.value = 0.55;
    const wlp = ctx.createBiquadFilter();
    wlp.type = 'lowpass';
    wlp.frequency.setValueAtTime(1600, t + 0.1);
    wlp.frequency.exponentialRampToValueAtTime(240, t + 1.1);
    const wg = ctx.createGain();
    wg.gain.setValueAtTime(0.0001, t + 0.1);
    wg.gain.linearRampToValueAtTime(0.5, t + 0.16);
    wg.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    wh.connect(wlp);
    wlp.connect(wg);
    wg.connect(out);
    wh.start(t + 0.1, Math.random() * 1.5, 1.15);
  }

  // сложить полено в поленницу: пара деревянных стуков — штабель принял
  woodStack() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    for (let i = 0; i < 2; i++) {
      const t = ctx.currentTime + 0.02 + i * (0.1 + Math.random() * 0.04);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(200 - i * 45 + Math.random() * 25, t);
      o.frequency.exponentialRampToValueAtTime(85 - i * 20, t + 0.06);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.linearRampToValueAtTime(0.32 - i * 0.08, t + 0.004);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
      o.connect(og);
      og.connect(this.master);
      o.start(t);
      o.stop(t + 0.13);
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 420 + Math.random() * 260;
      bp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.22, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      src.start(t, Math.random() * 1.5, 0.09);
    }
  }

  // взять топор: тот же деревянный перехват, что у лопаты, без её металла
  axeTake() {
    this.woodTake();
  }

  // воткнуть топор в колоду/наст: один сухой тюк
  axePlant() {
    this.axeChop();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  // k: 0..1 — насколько игрок «внутри» (стены глушат ветер и костёр)
  setIndoor(k) {
    this._indoorK = clamp(k, 0, 1); // треск деревьев тоже глушится стенами
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

  // Погода — не случайные порывы, а длинная дуга: долгое затишье → нарастание →
  // буря (пересидеть у огня или дома) → внезапное полное безветрие после
  // («звенящая тишина» — слышно только костёр и собственные шаги) → снова затишье.
  // windLevel читают туман/снегопад/хребты (main.js) — вся сцена дышит этой дугой.
  _scheduleWeather() {
    const PHASES = {
      calm: { next: 'build', dur: () => 150 + Math.random() * 150 },
      build: { next: 'storm', dur: () => 55 + Math.random() * 35 },
      storm: { next: 'lull', dur: () => 100 + Math.random() * 100 },
      lull: { next: 'calm', dur: () => 28 + Math.random() * 20 },
    };
    let phase = 'calm';
    let phaseT = 0;
    let phaseDur = PHASES.calm.dur();

    const tick = () => {
      const step = 2.5 + Math.random() * 3.5;
      phaseT += step;
      if (phaseT >= phaseDur) {
        phase = PHASES[phase].next;
        this.weatherPhase = phase;
        phaseT = 0;
        phaseDur = PHASES[phase].dur();
      }
      if (this.ctx) {
        const k = phaseT / phaseDur; // прогресс фазы 0..1
        let target, smooth = 1.8;
        if (phase === 'calm') target = 0.12 + Math.random() * 0.3;
        else if (phase === 'build') target = 0.25 + k * 0.45 + Math.random() * 0.18;
        else if (phase === 'storm') target = 0.72 + Math.random() * 0.28;
        else { // lull: ветер умирает совсем — тишина как событие
          target = 0.02;
          smooth = 3.5; // гаснет долго, «выдохом»
        }
        this.windLevel = target;
        this.windBus.gain.setTargetAtTime(
          target < 0.05 ? 0.02 : 0.25 + target * 0.75,
          this.ctx.currentTime, smooth
        );
      }
      setTimeout(tick, 3500 + Math.random() * 5500);
    };
    tick();
  }

  // Треск деревьев на лютом морозе: редкий «ружейный» щелчок в лесу —
  // резкий сухой удар + низкий отголосок ствола. Случайная сторона, глубина
  // по расстоянию (тише и глуше), в доме почти не слышно. Частота и громкость
  // растут с this.cold; в мороз слабее -13° лес молчит.
  _scheduleTreeCrack() {
    const tick = () => {
      setTimeout(tick, 12000 + Math.random() * 28000);
      if (!this.ctx || this.cold < 0.35) return;
      if (Math.random() > this.cold * 0.9) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + 0.05;
      const far = 0.35 + Math.random() * 0.65; // «расстояние» до дерева 0..1
      const muffle = 1 - 0.85 * this._indoorK;

      const out = ctx.createGain();
      out.gain.value = (0.5 - far * 0.32) * (0.6 + this.cold * 0.4) * muffle;
      const pan = ctx.createStereoPanner();
      pan.pan.value = (Math.random() * 2 - 1) * 0.8;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = (5200 - far * 3800) * (1 - 0.8 * this._indoorK);
      out.connect(pan);
      pan.connect(lp);
      lp.connect(this.master);

      // сухой щелчок раскалывающегося волокна
      const crack = ctx.createBufferSource();
      crack.buffer = this.noise;
      crack.playbackRate.value = 1.2 + Math.random() * 0.8;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 900 + Math.random() * 900;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.0001, t);
      cg.gain.linearRampToValueAtTime(1.0, t + 0.004);
      cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.07 + Math.random() * 0.05);
      crack.connect(hp);
      hp.connect(cg);
      cg.connect(out);
      crack.start(t, Math.random() * 1.5, 0.15);

      // низкий отголосок ствола — «гулкое» эхо удара по лесу
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120 + Math.random() * 60, t + 0.01);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.3);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t + 0.01);
      og.gain.linearRampToValueAtTime(0.35, t + 0.03);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      o.connect(og);
      og.connect(out);
      o.start(t);
      o.stop(t + 0.55);
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
    out.gain.value = (running ? 0.46 : 0.3) * (0.85 + Math.random() * 0.3);
    // снег глушит верх шага — тот же «войлок», что у вреза и приземления
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = (running ? 1900 : 1500) + this.cold * 700;
    soft.Q.value = 0.5;
    out.connect(soft);
    soft.connect(this.master);

    // хруст — серия шумовых «зёрен»: удар пятки + дробное сминание наста.
    // Чем злее мороз (this.cold), тем выше и суше скрипит снег под ногой —
    // температуру слышно походкой, как в жизни.
    // Первое зерно не выделено пиком: снег принимает пятку, а не отбивает её
    const cold = this.cold;
    const grains = 6 + ((Math.random() * 4) | 0);
    const spread = running ? 0.011 : 0.017;
    for (let i = 0; i < grains; i++) {
      const st = t + (i === 0 ? 0 : i * spread + Math.random() * 0.008);
      const dur = 0.02 + Math.random() * 0.03;

      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.playbackRate.value = 0.5 + Math.random() * 0.7 + cold * 0.3;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 160 + cold * 200;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = (running ? 1100 : 780) + Math.random() * 650 + cold * 700;
      lp.Q.value = 0.8;

      const g = ctx.createGain();
      const peak = (i === 0 ? 0.8 : 0.55 * Math.pow(0.84, i)) * (0.7 + Math.random() * 0.5);
      g.gain.setValueAtTime(0.0001, st);
      g.gain.linearRampToValueAtTime(peak, st + (i === 0 ? 0.014 : 0.007));
      g.gain.exponentialRampToValueAtTime(0.0001, st + dur + 0.06);

      src.connect(hp);
      hp.connect(lp);
      lp.connect(g);
      g.connect(out);
      src.start(st, Math.random() * 1.5, dur + 0.1);
    }

    // низкий «бух» — вес шага. Без свипа частоты: нога тонет, а не бьёт
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(running ? 66 : 58, t);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(running ? 0.26 : 0.15, t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + 0.24);
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
  // Снег принимает вес мягко: без свипа частоты (свип = кик-барабан),
  // атака размята, верх срезан. Доски — жёстче: у дерева атака есть.
  land(surface = 'snow', strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.005;
    const wood = surface === 'wood';

    const out = ctx.createGain();
    out.gain.value = clamp(0.44 + strength * 0.08, 0.44, 0.9);
    // снег глушит верх приземления так же, как верх вреза лопаты
    const soft = ctx.createBiquadFilter();
    soft.type = 'lowpass';
    soft.frequency.value = wood ? 2600 : 1300;
    soft.Q.value = 0.5;
    out.connect(soft);
    soft.connect(this.master);

    // низкий «бум» веса: по доскам — короткий удар со свипом, по снегу —
    // ровное придавливание с длинным мягким хвостом
    const o = ctx.createOscillator();
    o.type = 'sine';
    if (wood) {
      o.frequency.setValueAtTime(138, t);
      o.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    } else {
      o.frequency.setValueAtTime(62, t);
    }
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.linearRampToValueAtTime(wood ? 0.5 : 0.4, t + (wood ? 0.008 : 0.04));
    og.gain.exponentialRampToValueAtTime(0.0001, t + (wood ? 0.19 : 0.34));
    o.connect(og);
    og.connect(out);
    o.start(t);
    o.stop(t + (wood ? 0.22 : 0.38));

    // хруст/стук поверхности — шумовая пачка
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = wood ? 1.0 : 0.5;
    const filt = ctx.createBiquadFilter();
    if (wood) {
      filt.type = 'bandpass';
      filt.frequency.value = 320;
      filt.Q.value = 2.0;
    } else {
      filt.type = 'lowpass';
      filt.frequency.setValueAtTime(1100, t);
      filt.frequency.exponentialRampToValueAtTime(420, t + 0.22);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(wood ? 0.5 : 0.42, t + (wood ? 0.005 : 0.022));
    g.gain.exponentialRampToValueAtTime(0.0001, t + (wood ? 0.13 : 0.26));
    src.connect(filt);
    filt.connect(g);
    g.connect(out);
    src.start(t, Math.random() * 1.5, wood ? 0.17 : 0.3);
  }
}
