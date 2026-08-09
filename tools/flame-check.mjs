/**
 * Пламя счётом: не изменился ли огонь костра после переезда в общий модуль.
 *
 *     node tools/flame-check.mjs
 *
 * Форма пламени переехала из campfire.js в flame.js и стала параметром. Такой
 * переезд легко сделать «почти точно»: перепутанный порог или потерянный
 * множитель дают огонь, который в браузере выглядит правдоподобно, и разницу
 * замечаешь через неделю, когда сравнить уже не с чем.
 *
 * Поэтому здесь лежит ЭТАЛОН — формула костра ровно в том виде, в каком она
 * жила до переезда, — и кадры сверяются побайтово. Ноль расхождений или список
 * пикселей, где разошлось.
 *
 * Заодно меряется сам огонь камина: он обязан быть уже и выше костра, иначе
 * язык вылезет за устье топки.
 */
import { fbm, ss } from 'world-core/materials'
import { drawFlame, FLAME_DEFAULT, FLAME_HEARTH } from '../src/flame.js'
import { FLAME_W as SHEET_W, FLAME_H as SHEET_H, CAVITY, sideAt, LINER, FLAME_BASE, ASH_Y } from '../src/firebox.js'

const W = 72
const H = 108

// ---------------------------------------------------------------------------
// Эталон: _drawFlame из campfire.js до переезда, слово в слово.
// Трогать нельзя — это единственная копия «как было».
function reference(data, t, b) {
  const k = ss(0.12, 0.45, b)
  let i = 0
  for (let y = 0; y < H; y++) {
    const v = 1 - y / H
    const taper = Math.pow(1 - v, 0.62)
    const sway = Math.sin(t * 2.1 + v * 3.6) * 0.1 * v + Math.sin(t * 3.7 + v * 6) * 0.045 * v
    for (let x = 0; x < W; x++, i++) {
      const u = x / W - 0.5
      const turb = fbm((x / W) * 3.2, (y / H) * 3.4 + t * 1.35, 8, 64, 4, 1451) - 0.5
      const dist = Math.abs(u - sway) / (taper * 0.6 + 0.02)
      const val = 1 - dist + turb * (0.45 + v * 1.05) - v * 0.42
      const a = ss(0.26, 0.58, val) * (1 - ss(0.56, 0.95, v)) * ss(0, 0.045, v)
      const core = ss(0.55, 0.92, val) * (1 - ss(0.2, 0.72, v)) * 0.95
      const m = ss(0.3, 0.7, val)
      const r = 186 + (255 - 186) * m
      const g = 30 + (146 - 30) * m
      const bl = 4 + (26 - 4) * m
      const o = i * 4
      data[o] = r + (255 - r) * core
      data[o + 1] = g + (240 - g) * core
      data[o + 2] = bl + (196 - bl) * core
      data[o + 3] = a * 255 * k
    }
  }
}

// Канва округляет до байта при записи, поэтому сравниваем так же: разница
// меньше половины единицы в буфере до видеокарты всё равно не доедет.
const byte = (v) => Math.max(0, Math.min(255, Math.round(v)))

let bad = 0
let worst = 0
const CASES = []
for (const t of [0, 0.37, 1.6, 4.2, 11.9]) {
  for (const b of [0.1, 0.35, 0.7, 1]) CASES.push([t, b])
}

const a = new Float64Array(W * H * 4)
const c = new Float64Array(W * H * 4)
for (const [t, b] of CASES) {
  reference(a, t, b)
  drawFlame(c, W, H, t, b, FLAME_DEFAULT)
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(byte(a[i]) - byte(c[i]))
    if (d > 0) {
      bad++
      worst = Math.max(worst, d)
    }
  }
}

console.log(`костёр: ${CASES.length} кадров, ${W}x${H}`)
console.log(
  bad === 0
    ? '  ✓ огонь костра не изменился ни на байт'
    : `  ✗ разошлось в ${bad} байтах, максимум на ${worst}`
)

// ---------------------------------------------------------------------------
// Огонь камина: обязан быть уже и выше. Меряем по самому кадру, а не по
// параметрам — параметр можно поменять и забыть, чем всё кончилось.
function measure(shape) {
  const buf = new Float64Array(W * H * 4)
  let widest = 0
  let top = 0
  let area = 0
  for (const t of [0, 0.8, 2.3, 5.1]) {
    drawFlame(buf, W, H, t, 1, shape)
    for (let y = 0; y < H; y++) {
      let lo = -1
      let hi = -1
      for (let x = 0; x < W; x++) {
        if (buf[(y * W + x) * 4 + 3] > 24) {
          if (lo < 0) lo = x
          hi = x
          area++
        }
      }
      if (hi >= 0) {
        widest = Math.max(widest, (hi - lo + 1) / W)
        top = Math.max(top, 1 - y / H)
      }
    }
  }
  return { widest, top, fill: area / (W * H * 4) }
}

const fire = measure(FLAME_DEFAULT)
const hearth = measure(FLAME_HEARTH)
console.log('\nформа язычка (доля полотна):')
console.log(`  костёр  ширина ${fire.widest.toFixed(3)}  верх ${fire.top.toFixed(3)}  заполнение ${fire.fill.toFixed(3)}`)
console.log(`  камин   ширина ${hearth.widest.toFixed(3)}  верх ${hearth.top.toFixed(3)}  заполнение ${hearth.fill.toFixed(3)}`)

const claims = [
  ['огонь камина уже костра', hearth.widest < fire.widest],
  ['огонь камина достаёт не ниже костра', hearth.top >= fire.top - 0.02],
  ['огонь камина не забивает полотно целиком', hearth.fill < 0.5],
]
let failed = 0
for (const [name, ok] of claims) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

// Полотно и полость берутся из самой сцены (firebox.js), а не переписываются
// сюда числами: разъехавшаяся копия проверяла бы огонь в несуществующей топке.
const CAVITY_W = sideAt(CAVITY.mouth) * 2 - LINER * 2
const CAVITY_H = CAVITY.roof - LINER - FLAME_BASE
const flameW = hearth.widest * SHEET_W
const flameTop = hearth.top * SHEET_H
console.log(`\nв метрах: язык ${flameW.toFixed(3)} шириной, верхушка на ${flameTop.toFixed(3)} м`)
const fits = [
  ['язык не достаёт до боковых стенок топки', flameW < CAVITY_W - 0.12],
  ['язык не упирается в свод топки', flameTop < CAVITY_H - 0.08],
]
for (const [name, ok] of fits) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}`)
  if (!ok) failed++
}

if (bad || failed) process.exit(1)
console.log('\nвсё зелёное')
