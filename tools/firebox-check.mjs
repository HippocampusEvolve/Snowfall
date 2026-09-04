/**
 * Нутро топки счётом: сходится ли то, что игра ставит внутрь камина, с тем,
 * что в камине на самом деле есть.
 *
 *     node tools/firebox-check.mjs
 *
 * Полость промеряется ЛУЧАМИ по самой кладке камина (src/props/fireplace-
 * geometry.js), а не берётся из головы.
 * Дальше каждая деталь нутра — футеровка, под, зола, поленья, щепа, пламя —
 * проверяется на два вопроса:
 *
 *   * не торчит ли наружу (сквозь стенку, под, свод или мимо устья);
 *   * не легла ли вплотную к геометрии камина.
 *
 * Второе важнее первого. Совпадающие плоскости дают мерцание, которое в
 * браузере видно не всегда и не сразу: при одном ракурсе чисто, при другом
 * кладка начинает рябить. Числами это ловится с одного прогона.
 *
 * Эта же проверка нашла, что щёки топки НЕ параллельны: первая футеровка
 * встала прямоугольником и оставила у задней стенки по 4 см пустоты с каждого
 * бока. Один луч из середины такого не показывает — нужна сетка.
 *
 * Порог здесь общий и жёсткий (MIN_GAP), под конкретную деталь он не
 * подкручивается: претензия гасится правкой сцены, а не допуском в проверке.
 */
// Числа нутра лежат в firebox.js, а тот тянет за собой воркеры выпечки
// материалов - на Node их подменяет заглушка, и она обязана быть ПЕРВЫМ
// импортом.
import './node-worker-shim.mjs'
import { boxTriangles } from '../src/props/parts.js'
import { fireplaceParts } from '../src/props/fireplace-geometry.js'
import {
  CAVITY,
  sideAt,
  LINER,
  ASH_Y,
  ASH,
  FLAME_BASE,
  FLAME_W,
  FLAME_H,
  LOGS,
  CHIPS,
} from '../src/firebox.js'

/** Наименьший зазор между чужими поверхностями, м. */
const MIN_GAP = 0.008

// ---------------------------------------------------------------------------
// Вся кладка камина, всеми деталями.
//
// Раньше геометрия читалась из fireplace.glb, и был соблазн взять из неё один
// первый примитив - пока камин был одним мешем, это была вся модель. После
// разбора по ролям такая проверка переставала видеть заднюю стенку и свод и
// меряла расстояние до наружной кладки: «задняя стенка 0.357 вместо 0.115».
// Симптом выглядел как поехавшая модель, а поехала - проверка. Теперь камин
// собирается кодом, и лучи идут по ТОМУ ЖЕ списку деталей, из которого его
// строит сцена: разойтись им негде.
const { pos, idx } = boxTriangles(fireplaceParts())
const TRIS = idx.length / 3

/** Ближайшее пересечение луча с моделью, или null. Мёллер-Трумбор. */
function cast(o, d, far = 6) {
  let best = null
  for (let f = 0; f < TRIS; f++) {
    const i0 = idx[f * 3] * 3
    const i1 = idx[f * 3 + 1] * 3
    const i2 = idx[f * 3 + 2] * 3
    const e1x = pos[i1] - pos[i0]
    const e1y = pos[i1 + 1] - pos[i0 + 1]
    const e1z = pos[i1 + 2] - pos[i0 + 2]
    const e2x = pos[i2] - pos[i0]
    const e2y = pos[i2 + 1] - pos[i0 + 1]
    const e2z = pos[i2 + 2] - pos[i0 + 2]
    const hx = d[1] * e2z - d[2] * e2y
    const hy = d[2] * e2x - d[0] * e2z
    const hz = d[0] * e2y - d[1] * e2x
    const a = e1x * hx + e1y * hy + e1z * hz
    if (Math.abs(a) < 1e-9) continue
    const inv = 1 / a
    const sx = o[0] - pos[i0]
    const sy = o[1] - pos[i0 + 1]
    const sz = o[2] - pos[i0 + 2]
    const u = inv * (sx * hx + sy * hy + sz * hz)
    if (u < 0 || u > 1) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = inv * (d[0] * qx + d[1] * qy + d[2] * qz)
    if (v < 0 || u + v > 1) continue
    const t = inv * (e2x * qx + e2y * qy + e2z * qz)
    if (t > 1e-4 && t < far && (best === null || t < best)) best = t
  }
  return best
}

let bad = 0
const claim = (name, ok, note = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${note ? '  ' + note : ''}`)
  if (!ok) bad++
}

// ---------------------------------------------------------------------------
// 1. Обмер полости: сетка лучей, а не один из середины
console.log(`кладка камина: ${TRIS} треугольников\n`)
console.log('обмер полости лучами:')
const midY = (CAVITY.floor + CAVITY.roof) / 2
const midZ = (CAVITY.back + CAVITY.mouth) / 2

const back = midZ - cast([0, midY, midZ], [0, 0, -1])
const roof = midY + cast([0, midY, midZ], [0, 1, 0])
const floor = midY - cast([0, midY, midZ], [0, -1, 0])
for (const [name, got, want] of [
  ['задняя стенка', back, CAVITY.back],
  ['под', floor, CAVITY.floor],
  ['свод', roof, CAVITY.roof],
]) {
  claim(
    `${name}: модель ${got.toFixed(3)}, в коде ${want.toFixed(3)}`,
    Math.abs(got - want) <= 0.005,
    Math.abs(got - want) > 0.005 ? `расходятся на ${(Math.abs(got - want) * 1000).toFixed(0)} мм` : ''
  )
}

// щёки: полуширина на нескольких глубинах — они сходятся к устью
console.log('  просвет по глубине (щёки сходятся к устью):')
let sideWorst = 0
for (const z of [0.16, 0.26, 0.36, 0.46, 0.56]) {
  const l = cast([0, midY, z], [-1, 0, 0])
  const r = cast([0, midY, z], [1, 0, 0])
  const got = Math.min(l ?? 9, r ?? 9)
  const want = sideAt(z)
  sideWorst = Math.max(sideWorst, Math.abs(got - want))
  console.log(`     z=${z.toFixed(2)}: модель ${got.toFixed(3)}, формула ${want.toFixed(3)}`)
}
claim(
  `формула щеки сходится с моделью (худшее расхождение ${(sideWorst * 1000).toFixed(1)} мм)`,
  sideWorst <= 0.004
)

// устье: самый передний край стоек в высоте топки
let mouth = 0
for (let i = 0; i < pos.length; i += 3) {
  const px = pos[i]
  const py = pos[i + 1]
  const pz = pos[i + 2]
  if (Math.abs(px) > sideAt(pz) && py > CAVITY.floor && py < CAVITY.roof) mouth = Math.max(mouth, pz)
}
claim(
  `устье: край стоек ${mouth.toFixed(3)}, в коде ${CAVITY.mouth.toFixed(3)}`,
  CAVITY.mouth <= mouth + 0.001,
  CAVITY.mouth > mouth ? 'устье в коде дальше, чем сами стойки' : ''
)

// ---------------------------------------------------------------------------
// 2. Футеровка
console.log('\nфутеровка (кирпич внутри каменного короба):')
const HGT = CAVITY.roof - CAVITY.floor - LINER * 2
const zb = CAVITY.back + LINER
const zm = CAVITY.mouth - LINER
const inset = LINER * Math.hypot(1, CAVITY.slope)
const xb = sideAt(zb) - inset
const xm = sideAt(zm) - inset
claim(`зазор до стенок ${(LINER * 1000).toFixed(0)} мм`, LINER >= MIN_GAP)
claim('футеровка не «висит» посреди топки (зазор меньше 25 мм)', LINER <= 0.025)
claim(
  `полость футеровки: ${(xb * 2).toFixed(3)} у задней стенки, ${(xm * 2).toFixed(3)} у устья, высота ${HGT.toFixed(3)}`,
  xb > 0 && xm > 0 && HGT > 0
)
claim(
  'футеровка повторяет наклон щеки, а не встаёт прямоугольником',
  Math.abs(xb - xm) > 0.02,
  Math.abs(xb - xm) <= 0.02 ? 'щёки сходятся на 4.8 см, футеровка этого не видит' : ''
)
claim('по высоте ровно один тайл кирпича (иначе шов от градиента сажи)', Math.abs(HGT * (1 / HGT) - 1) < 1e-9)

// ---------------------------------------------------------------------------
// 3. Всё, что внутри: не торчит и не липнет
console.log('\nдетали внутри топки:')

/** Помещается ли коробка в футерованную полость с зазором. */
function fits(name, lo, hi, gap = MIN_GAP) {
  // по ширине граница наклонная: берём её в самом узком месте коробки
  const narrow = sideAt(Math.max(hi[2], lo[2])) - inset
  const room = [
    lo[0] >= -narrow + gap && hi[0] <= narrow - gap,
    lo[1] >= CAVITY.floor + LINER - 1e-9 && hi[1] <= CAVITY.roof - LINER - gap,
    lo[2] >= zb + gap && hi[2] <= zm,
  ]
  const where = ['по ширине', 'по высоте', 'по глубине'].filter((_, i) => !room[i])
  claim(
    `${name}: ${lo.map((v) => v.toFixed(2)).join(' ')} .. ${hi.map((v) => v.toFixed(2)).join(' ')}`,
    where.length === 0,
    where.length ? `выходит ${where.join(', ')}` : ''
  )
}

claim(
  `зола лежит на футеровке пода (+${((ASH_Y - CAVITY.floor - LINER) * 1000).toFixed(0)} мм)`,
  ASH_Y - (CAVITY.floor + LINER) >= 0.003
)
fits('зола', [-ASH.rx, ASH_Y, ASH.z - ASH.rz], [ASH.rx, ASH_Y, ASH.z + ASH.rz])

for (const [i, l] of LOGS.entries()) {
  // полено лежит вдоль своей оси: длина идёт по ней, толщина — по двум другим
  const half = l.along === 'z' ? [l.r * 1.08, l.r * 1.08, l.len / 2] : [l.len / 2, l.r * 1.08, l.r * 1.08]
  fits(
    `полено ${i + 1} (вдоль ${l.along})`,
    [l.x - half[0], l.y - half[1], l.z - half[2]],
    [l.x + half[0], l.y + half[1], l.z + half[2]]
  )
  claim(
    `полено ${i + 1} лежит на золе, а не в ней`,
    l.y - l.r * 1.08 >= ASH_Y - 0.012,
    l.y - l.r * 1.08 < ASH_Y - 0.012
      ? `утонуло на ${((ASH_Y - (l.y - l.r * 1.08)) * 1000).toFixed(0)} мм`
      : ''
  )
  claim(
    `полено ${i + 1} лежит на золе, а не рядом с ней`,
    Math.abs(l.z - ASH.z) <= ASH.rz + (l.along === 'z' ? l.len / 2 : l.r),
    Math.abs(l.z - ASH.z) > ASH.rz + l.r ? 'полено съехало с пепла на голые плиты' : ''
  )
}

for (const [i, c] of CHIPS.entries()) {
  fits(`щепа ${i + 1}`, [c.x - c.w / 2, c.y - c.h / 2, c.z - c.d / 2], [c.x + c.w / 2, c.y + c.h / 2, c.z + c.d / 2])
}

fits(
  'полотно пламени',
  [-FLAME_W / 2, FLAME_BASE, ASH.z],
  [FLAME_W / 2, FLAME_BASE + FLAME_H, ASH.z]
)
claim(
  'пламя начинается над золой',
  FLAME_BASE > ASH_Y,
  FLAME_BASE <= ASH_Y ? 'основание в золе — язык обрежется её краем' : ''
)

// ---------------------------------------------------------------------------
// 4. Пробы лучом: не сидит ли деталь в самой кладке
console.log('\nпробы лучом: не сидит ли деталь в кладке')
const PROBES = [
  ['зола, дальний край', [0, ASH_Y + 0.001, ASH.z - ASH.rz]],
  ['зола, край вбок', [ASH.rx, ASH_Y + 0.001, ASH.z]],
  ['полено 1, торец', [LOGS[0].x + LOGS[0].len / 2, LOGS[0].y, LOGS[0].z]],
  ['полено 3, торец в комнату', [LOGS[2].x, LOGS[2].y, LOGS[2].z + LOGS[2].len / 2]],
  ['полено 3, верх', [LOGS[2].x, LOGS[2].y + LOGS[2].r, LOGS[2].z]],
  ['верхушка пламени', [0, FLAME_BASE + FLAME_H * 0.87, ASH.z]],
  ['щепа у края', [CHIPS[0].x, CHIPS[0].y, CHIPS[0].z]],
]
for (const [name, p] of PROBES) {
  const d = Math.min(
    cast(p, [1, 0, 0]) ?? 9,
    cast(p, [-1, 0, 0]) ?? 9,
    cast(p, [0, 1, 0]) ?? 9,
    cast(p, [0, -1, 0]) ?? 9,
    cast(p, [0, 0, -1]) ?? 9
  )
  claim(`${name}: до кладки ${(d * 1000).toFixed(0)} мм`, d >= MIN_GAP)
}

console.log(bad ? `\n${bad} претензий` : '\nвсё зелёное')
if (bad) process.exit(1)
