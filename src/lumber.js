import * as THREE from 'three';

// Рубка леса (VISION.md: «дерево валится по-настоящему — скрип, треск, ух
// в сугроб, облако снежной пыли»). Стоящая сосна принимает удары топора:
// дрожит крона, летит щепа; после последнего удара — скрип, накрен и падение
// с настоящим поворотом инстанса вокруг комля. Рухнувший ствол лежит и
// разделывается тем же топором на поленья; с последним поленом ствол
// РАССЫПАЕТСЯ и исчезает — на месте остаётся только вмятина в снегу.
// Сваленное переживает перезагрузку (serialize/restore + seeded-лес в
// trees.js). Саженцы (sapling, без коллайдера) валятся с одного удара
// и дают одно полено.

const REACH = 2.1; // м — дотягивается ли топор до ствола
const REACH_LOG = 1.8; // м — до лежащего ствола (он толще и ниже)
const AIM = 0.45; // мин. косинус между взглядом и направлением на цель
const FALL_DUR = 2.1; // с — от последнего удара до удара о снег
const FALL_END = Math.PI / 2 - 0.05; // не ровно 90° — комель утопает в сугробе
const CHOPS_PER_LOG = 2; // ударов на одно полено при разделке

const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _zero = new THREE.Vector3(0, 0, 0);
const _axis = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _t = new THREE.Matrix4();
const _tinv = new THREE.Matrix4();
const _m = new THREE.Matrix4();

export class Lumber {
  // pines — записи trees.js; colliders — общий реестр (валка подменяет столб
  // ствола лежачим отрезком); groundLogs — куда падают наколотые поленья;
  // deps: { audio, footprints, dust (Burst снежной пыли), groundAt(x,z),
  //         avoid: [{x,z,r}] — куда деревья не валим (дом, костёр),
  //         onCrash(dist) — толчок камеры при ударе ствола о снег }
  constructor(pines, colliders, groundLogs, deps) {
    this.pines = pines;
    this.colliders = colliders;
    this.groundLogs = groundLogs;
    this.deps = deps;
    this.animating = false; // идёт валка/дрожь — main перерисовывает тени
    for (const p of pines) {
      p.state = 'up'; // 'up' | 'falling' | 'down' | 'gone' (разделан до конца)
      p.hits = 0; // зарубка на стоящем стволе
      p.chops = 0; // удары разделки лежащего
      p.wood = 0; // сколько поленьев осталось в лежащем стволе
      // ударов до валки; хлыстик-саженец срубается одним
      p.need = p.sapling ? 1 : THREE.MathUtils.clamp(Math.round(3 + p.h * 0.4), 5, 9);
      p.fallYaw = 0;
      p.fallT = -1;
      p.lieOb = null; // коллайдер лежащего ствола (снимается при исчезновении)
      p.wobA = 0; // дрожь от удара: амплитуда и фаза
      p.wobT = 0;
    }
  }

  // Удар топора из камеры. Возвращает null (промах — только свист) или
  // { kind: 'trunk' | 'log', point, out } — точка зарубки и направление
  // выброса щепы; звук и брызги играет вызывающий (main.js).
  chop(camera, playerPos) {
    camera.getWorldDirection(_dir);
    let best = null;
    let bestDot = AIM;

    for (const p of this.pines) {
      if (p.state === 'falling' || p.state === 'gone') continue;
      let tx, ty, tz, reach;
      if (p.state === 'up') {
        tx = p.x;
        tz = p.z;
        ty = THREE.MathUtils.clamp(camera.position.y, p.y + 0.3, p.y + 1.7);
        reach = REACH + p.r;
      } else {
        if (p.wood <= 0) continue; // голый ствол — древесина вышла
        // ближайшая точка лежащего ствола (отрезок комель → крона)
        const ex = p.x + Math.sin(p.fallYaw) * p.h * 0.75;
        const ez = p.z + Math.cos(p.fallYaw) * p.h * 0.75;
        const abx = ex - p.x;
        const abz = ez - p.z;
        const k = THREE.MathUtils.clamp(
          ((playerPos.x - p.x) * abx + (playerPos.z - p.z) * abz) / (abx * abx + abz * abz),
          0,
          1
        );
        tx = p.x + abx * k;
        tz = p.z + abz * k;
        ty = p.y + 0.3;
        reach = REACH_LOG;
      }
      const dx = tx - playerPos.x;
      const dz = tz - playerPos.z;
      if (dx * dx + dz * dz > reach * reach) continue;
      _to.set(tx - camera.position.x, ty - camera.position.y, tz - camera.position.z).normalize();
      const dot = _to.dot(_dir);
      if (dot > bestDot) {
        bestDot = dot;
        best = { p, tx, ty, tz };
      }
    }
    if (!best) return null;

    const p = best.p;
    // точка зарубки — на поверхности ствола со стороны игрока
    const toPx = playerPos.x - best.tx;
    const toPz = playerPos.z - best.tz;
    const d = Math.hypot(toPx, toPz) || 1;
    const rr = p.state === 'up' ? p.r : 0.3;
    const point = new THREE.Vector3(
      best.tx + (toPx / d) * rr,
      best.ty,
      best.tz + (toPz / d) * rr
    );
    const out = new THREE.Vector3((toPx / d) * 0.9, 0.7, (toPz / d) * 0.9);

    if (p.state === 'up') {
      p.hits++;
      // дрожь кроны: свежая зарубка встряхивает дерево, к валке — сильнее
      p.wobA = Math.min(0.012 + p.hits * 0.0035, 0.035);
      p.wobT = 0;
      this.animating = true;
      if (p.hits >= p.need) this._startFall(p, playerPos);
      return { kind: 'trunk', point, out };
    }

    // разделка лежащего: каждый CHOPS_PER_LOG-й удар отделяет полено
    p.chops++;
    let split = false;
    if (p.chops % CHOPS_PER_LOG === 0) {
      p.wood--;
      split = true;
      // полено откатывается вбок от ствола
      const side = Math.random() < 0.5 ? 1 : -1;
      const px = Math.cos(p.fallYaw) * side;
      const pz = -Math.sin(p.fallYaw) * side;
      const lx = best.tx + px * (0.55 + Math.random() * 0.25);
      const lz = best.tz + pz * (0.55 + Math.random() * 0.25);
      this.groundLogs.drop(lx, this.deps.groundAt(lx, lz), lz, p.fallYaw + Math.PI / 2 + (Math.random() - 0.5) * 0.5);
      // с последним поленом голый ствол рассыпается — лес не захламляется
      if (p.wood <= 0) this._vanish(p);
    }
    return { kind: 'log', point, out, split };
  }

  _startFall(p, playerPos) {
    // валим от игрока; если крона легла бы на дом/костёр — валим прочь от них
    let fx = p.x - playerPos.x;
    let fz = p.z - playerPos.z;
    let d = Math.hypot(fx, fz) || 1;
    fx /= d;
    fz /= d;
    for (const av of this.deps.avoid) {
      const ex = p.x + fx * p.h;
      const ez = p.z + fz * p.h;
      if ((ex - av.x) ** 2 + (ez - av.z) ** 2 < av.r * av.r) {
        fx = p.x - av.x;
        fz = p.z - av.z;
        d = Math.hypot(fx, fz) || 1;
        fx /= d;
        fz /= d;
        break;
      }
    }
    p.state = 'falling';
    p.fallT = 0;
    p.fallYaw = Math.atan2(fx, fz);
    p.wobA = 0;
    this.animating = true;
    this.deps.audio.treeCreak(FALL_DUR);
  }

  // матрица инстанса: поворот на angle вокруг горизонтальной оси через комель
  _write(p, angle) {
    const fx = Math.sin(p.fallYaw);
    const fz = Math.cos(p.fallYaw);
    _axis.set(fz, 0, -fx); // вершина уходит в сторону (fx, fz)
    _rot.makeRotationAxis(_axis, angle);
    _t.makeTranslation(p.x, p.y, p.z);
    _tinv.makeTranslation(-p.x, -p.y, -p.z);
    _m.copy(p.base).premultiply(_tinv).premultiply(_rot).premultiply(_t).multiply(p.pre);
    this._apply(p, _m);
  }

  // записать матрицу во все меши инстанса + обновить сферу фрустум-куллинга:
  // three считает её по матрицам инстансов ОДИН раз, и лёгшее дерево вылезает
  // за кэшированную сферу — глядя на крону, мешь целиком отсекался (дерево
  // исчезало, тень оставалась)
  _apply(p, m) {
    for (const part of p.parts) {
      part.mesh.setMatrixAt(part.i, m);
      part.mesh.instanceMatrix.needsUpdate = true;
      part.mesh.computeBoundingSphere();
    }
  }

  // древесина вышла: ствол рассыпается в труху и исчезает из мира
  _vanish(p, quiet = false) {
    p.state = 'gone';
    const idx = this.colliders.indexOf(p.lieOb);
    if (idx >= 0) this.colliders.splice(idx, 1);
    p.lieOb = null;
    // нулевой масштаб на месте комля — инстанс не рисуется и не раздувает сферу
    _m.makeTranslation(p.x, p.y, p.z).scale(_zero);
    this._apply(p, _m);
    if (quiet) return; // восстановление из сейва
    // облачко трухи и снега вдоль лежавшего ствола
    const fx = Math.sin(p.fallYaw);
    const fz = Math.cos(p.fallYaw);
    for (let i = 0; i < 3; i++) {
      const k = 0.2 + (i / 3) * 0.6;
      _to.set(p.x + fx * p.h * k, p.y + 0.3, p.z + fz * p.h * k);
      _dir.set(0, 0.9, 0);
      this.deps.dust.spawn(_to, _dir, 10);
    }
  }

  _crash(p, playerPos, quiet = false) {
    p.state = 'down';
    p.fallT = -1;
    this._write(p, FALL_END);
    p.wood = p.sapling ? 1 : THREE.MathUtils.clamp(Math.round(p.h * 0.8), 4, 10);
    p.chops = 0;

    // столб коллайдера → лежачий отрезок вдоль ствола (через него не пройти,
    // но подкоп диггером под ним честно пропускает — y0/y1); хлыстик-саженец
    // и стоя был проходим — лёжа тоже не мешает ногам
    const idx = this.colliders.indexOf(p.ob);
    if (idx >= 0) this.colliders.splice(idx, 1);
    const fx = Math.sin(p.fallYaw);
    const fz = Math.cos(p.fallYaw);
    if (!p.sapling) {
      p.lieOb = {
        x1: p.x,
        z1: p.z,
        x2: p.x + fx * p.h * 0.75,
        z2: p.z + fz * p.h * 0.75,
        r: 0.32,
        y0: p.y - 0.5,
        y1: p.y + 0.8,
      };
      this.colliders.push(p.lieOb);
    }
    if (quiet) return; // восстановление из сейва — без грохота

    // ух в сугроб: вмятина по всей длине, снежная пыль с кроны, толчок земли;
    // саженец падает тихо и мелко — эффекты по росту
    const sc = Math.min(1, p.h / 9);
    const dust = this.deps.dust;
    for (let i = 0; i < 5; i++) {
      const k = 0.15 + (i / 5) * 0.85;
      const cx = p.x + fx * p.h * k;
      const cz = p.z + fz * p.h * k;
      this.deps.footprints.stampCircle(cx, cz, (0.9 + k * 0.9) * Math.max(sc, 0.35), 0.75);
      _to.set(cx, p.y + 0.4, cz);
      _dir.set(0, (1.6 + k) * sc, 0);
      dust.spawn(_to, _dir, Math.round(26 * sc) + 4);
    }
    const dist = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
    this.deps.audio.treeFall(dist + (1 - sc) * 8); // мелкое звучит как далёкое — тише
    this.deps.onCrash(dist * (p.sapling ? 3 : 1));
  }

  update(dt, playerPos) {
    this.animating = false;
    for (const p of this.pines) {
      if (p.state === 'falling') {
        this.animating = true;
        p.fallT += dt;
        const t = Math.min(p.fallT / FALL_DUR, 1);
        // накрен разгоняется как настоящий рычаг: сперва еле заметно, у земли — ух
        this._write(p, FALL_END * Math.pow(t, 2.6));
        if (t >= 1) this._crash(p, playerPos);
      } else if (p.wobA > 0.0015) {
        this.animating = true;
        p.wobT += dt;
        p.wobA *= Math.exp(-2.6 * dt);
        if (p.state === 'up') {
          // дрожь — колебание в сторону последнего удара с затуханием;
          // ось не важна точно, важен сам вздрог кроны
          p.fallYaw = p.fallYaw || 0;
          this._write(p, Math.sin(p.wobT * 19) * p.wobA);
        }
      } else if (p.wobA > 0) {
        p.wobA = 0;
        if (p.state === 'up') this._write(p, 0); // осела ровно в базовую позу
      }
    }
  }

  serialize() {
    const out = [];
    for (const p of this.pines) {
      if (p.state === 'up') {
        if (p.hits > 0) out.push([p.id, 0, p.hits]); // зарубки тоже память
      } else {
        // падающее на момент сейва — уже лежит: [-1] маркер поваленного
        out.push([p.id, 1, p.wood, Math.round(p.fallYaw * 100) / 100]);
      }
    }
    return out;
  }

  restore(arr, playerPos) {
    for (const [id, downed, a, yaw] of arr) {
      const p = this.pines[id];
      if (!p) continue;
      if (!downed) {
        p.hits = a;
      } else {
        p.fallYaw = yaw || 0;
        this._crash(p, playerPos, true);
        p.wood = a;
        if (p.wood <= 0) this._vanish(p, true); // разделан до конца ещё той ночью
      }
    }
  }
}
