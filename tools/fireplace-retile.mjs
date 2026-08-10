/**
 * Камин: с запечённого атласа на тайлящиеся материалы ядра.
 *
 *     node tools/fireplace-retile.mjs [--dry]
 *
 * ## Зачем
 *
 * Вся модель камина лежала в ОДНОМ атласе 1024x1024 - цвет, ORM и нормали,
 * запечённые в Blender. Замер по самой модели:
 *
 *     площадь поверхности        50.9 м²
 *     пикселей атласа на метр    56          (один тексель - 1.8 см)
 *     занято UV-островами        15.4%       (85% карты - пустота)
 *     полезных пикселей          162k из 1049k, то есть карта 400x400
 *
 * Каждому каменному блоку доставалось пятнышко примерно 20 на 20 пикселей. Это
 * не «текстура низкого качества» - это отсутствие текстуры: на такой площади
 * нельзя нарисовать ни скол, ни фаску, ни зерно. Отсюда и ощущение мыла, с
 * которого начался этот заход.
 *
 * ## Что делает
 *
 * Атлас выбрасывается совсем, а поверхность считается в игре генераторами
 * `world-core`. Чтобы тайлящаяся карта легла правильно, модели нужны две вещи,
 * и обе делает этот скрипт:
 *
 *   1. РАЗВЁРТКА В МЕТРАХ. Кубическая проекция по мировым осям, TILES_PER_M
 *      тайлов на метр. Кладка получает один и тот же размер и на щеке в
 *      полметра, и на дымосборнике в три - ровно то же правило, что у `boxUV`
 *      в ядре, только применённое к готовой геометрии.
 *   2. РАЗДЕЛЕНИЕ ПО РОЛЯМ. В атласе наружный бут, кирпич топки и деревянная
 *      полка были одним серо-бежевым камнем. Здесь модель разбирается на
 *      связные детали, каждая получает роль по своему месту в камине (те же
 *      правила, что в стадии формы `tools/blender-prop/props/fireplace`), и
 *      уезжает в свой примитив со своим материалом.
 *
 * Blender для этого не нужен: запекания больше нет, а всё остальное -
 * арифметика. Запечённую занятость (aoMap) не жаль: three.js применяет её
 * только к непрямому свету, а картинку в этой комнате лепит точечный огонь.
 *
 * Прогон повторим: из одной и той же исходной модели получается один и тот же
 * файл. Исходник держит git - отката ради него отдельной копии не заводим.
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readGLB, writeGLB } from './glb.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const GLB = path.join(here, '..', 'public', 'models', 'props', 'fireplace.glb')
const DRY = process.argv.includes('--dry')

/**
 * Тайлов на метр.
 *
 * Единица - это «одна карта на метр поверхности». У тёсаной кладки в карте
 * четыре ряда, значит камень выходит по 25 см - обычный размер бутового блока в
 * печной щеке. При карте 512 это 512 пикселей на метр против нынешних 56.
 */
const TILES_PER_M = 1

/**
 * Роли по месту в камине. Числа - обмер модели, те же, что в стадии формы.
 *
 * Оси в .glb: X - ширина, Y - высота, Z - вглубь комнаты (устье смотрит в +Z).
 * В Blender высота была по Z, поэтому числа стадии переносятся на Y.
 */
const SHELF = [1.24, 1.55] // брус полки: единственная деталь во всю ширину на этой высоте
const FLUE_Y = 1.52 // выше - дымосборник
const CAVITY_ROOF = 1.1
const CAVITY_FLOOR = 0.16
const WIDE = 1.5 // «во всю ширину камина»

/** Материал по роли. Имена читает игра - см. `src/cabin.js`. */
const MATERIAL = { rubble: 'stone', flue: 'stone', brick: 'firebrick', beam: 'timber' }

// ---------------------------------------------------------------------------
// разбор
const { json, accessor, bytes } = readGLB(GLB)
const prim = json.meshes[0].primitives[0]
const pos = accessor(prim.attributes.POSITION)
const idx = accessor(prim.indices)
const TRIS = idx.length / 3

const box = (list) => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const v of list) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], pos[v * 3 + k])
      hi[k] = Math.max(hi[k], pos[v * 3 + k])
    }
  }
  return { lo, hi }
}
const whole = box([...Array(pos.length / 3).keys()])

// ---------------------------------------------------------------------------
// детали: связные компоненты по СВАРЕННЫМ вершинам
//
// Варить обязательно. В .glb вершина разделена по нормали и по UV, поэтому у
// соседних граней одного блока индексы разные, и без сварки каждая грань
// оказалась бы отдельной «деталью». Порог 0.1 мм - меньше любого зазора в этой
// модели (самый тесный стык кладки - 3 мм) и больше ошибки округления float.
const WELD = 1e-4
const key = (v) =>
  `${Math.round(pos[v * 3] / WELD)},${Math.round(pos[v * 3 + 1] / WELD)},${Math.round(pos[v * 3 + 2] / WELD)}`
const weldOf = new Map()
const welded = new Int32Array(pos.length / 3)
for (let v = 0; v < pos.length / 3; v++) {
  const k = key(v)
  if (!weldOf.has(k)) weldOf.set(k, weldOf.size)
  welded[v] = weldOf.get(k)
}

const parent = new Int32Array(weldOf.size).map((_, i) => i)
const find = (a) => {
  while (parent[a] !== a) a = parent[a] = parent[parent[a]]
  return a
}
const union = (a, b) => {
  a = find(a)
  b = find(b)
  if (a !== b) parent[b] = a
}
for (let t = 0; t < TRIS; t++) {
  const a = welded[idx[t * 3]]
  const b = welded[idx[t * 3 + 1]]
  const c = welded[idx[t * 3 + 2]]
  union(a, b)
  union(a, c)
}

/** Деталь, которой принадлежит треугольник. */
const partOf = new Int32Array(TRIS)
const parts = new Map() // корень -> { tris:[], verts:Set }
for (let t = 0; t < TRIS; t++) {
  const root = find(welded[idx[t * 3]])
  partOf[t] = root
  if (!parts.has(root)) parts.set(root, { tris: [], verts: new Set() })
  const p = parts.get(root)
  p.tris.push(t)
  for (let k = 0; k < 3; k++) p.verts.add(idx[t * 3 + k])
}

// ---------------------------------------------------------------------------
// роли
const roleOf = new Map()
const counts = { rubble: 0, brick: 0, beam: 0, flue: 0 }
for (const [root, p] of parts) {
  const { lo, hi } = box([...p.verts])
  const w = hi[0] - lo[0]
  let role
  if (lo[1] >= SHELF[0] && hi[1] <= SHELF[1] && w > WIDE) role = 'beam'
  else if (lo[1] >= FLUE_Y) role = 'flue'
  else if (hi[1] <= CAVITY_ROOF + 0.2 && lo[1] >= CAVITY_FLOOR - 0.05 && w > WIDE) role = 'brick'
  else role = 'rubble'
  roleOf.set(root, role)
  counts[role]++
}

// ---------------------------------------------------------------------------
// развёртка в метрах, кубической проекцией
//
// Ось проекции выбирается по нормали ГРАНИ, а не вершины: у сглаженной модели
// нормаль вершины усреднена по соседям и на ребре смотрит наискось, отчего
// грань спроецировалась бы не на ту пару осей. Отсюда же и разделение вершин по
// треугольникам - одна вершина на стыке двух граней нуждается в двух разных UV.
//
// Пары осей подобраны так, чтобы вертикаль модели всегда шла по V. Это не
// косметика: у кладки есть ряды, и на вертикальной стене они обязаны быть
// горизонтальными, а не встать столбиками.
const AXES = [
  [2, 1], // нормаль по X: боковина, U вглубь, V вверх
  [0, 2], // нормаль по Y: пол или полка, U вширь, V вглубь
  [0, 1], // нормаль по Z: фасад, U вширь, V вверх
]

/**
 * У дерева развёртка повёрнута на четверть: V идёт ВДОЛЬ бруса.
 *
 * У генератора бруса волокно задано по V, а следы топора - по U, и это не
 * произвол: так лежит настоящий тёсаный брус. Кубическая проекция по общим
 * правилам кладёт на полку V поперёк, и тогда семь затёсов на тайл сходятся на
 * двадцати сантиметрах глубины в рябь, которую глаз читает как мокрый металл, -
 * это было видно в первом же контрольном кадре. Полка лежит вдоль X, поэтому
 * длинная ось и становится V.
 */
const AXES_WOOD = [
  [2, 1], // торец бруса: как есть, там всё равно
  [2, 0], // верх и низ полки: U вглубь, V вдоль бруса
  [1, 0], // перед и зад: U вверх, V вдоль бруса
]

const out = new Map() // роль -> { pos:[], nor:[], uv:[], idx:[], seen:Map }
for (const r of Object.keys(MATERIAL)) {
  if (!counts[r]) continue
  const mat = MATERIAL[r]
  if (!out.has(mat)) out.set(mat, { pos: [], nor: [], uv: [], idx: [], seen: new Map() })
}

for (let t = 0; t < TRIS; t++) {
  const role = roleOf.get(partOf[t])
  const g = out.get(MATERIAL[role])
  const axes = role === 'beam' ? AXES_WOOD : AXES
  const v = [idx[t * 3], idx[t * 3 + 1], idx[t * 3 + 2]]
  const P = v.map((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]])
  const e1 = [P[1][0] - P[0][0], P[1][1] - P[0][1], P[1][2] - P[0][2]]
  const e2 = [P[2][0] - P[0][0], P[2][1] - P[0][1], P[2][2] - P[0][2]]
  const n = [
    e1[1] * e2[2] - e1[2] * e2[1],
    e1[2] * e2[0] - e1[0] * e2[2],
    e1[0] * e2[1] - e1[1] * e2[0],
  ]
  const len = Math.hypot(...n) || 1
  const nn = n.map((c) => c / len)
  let ax = 0
  if (Math.abs(nn[1]) >= Math.abs(nn[0]) && Math.abs(nn[1]) >= Math.abs(nn[2])) ax = 1
  else if (Math.abs(nn[2]) >= Math.abs(nn[0]) && Math.abs(nn[2]) >= Math.abs(nn[1])) ax = 2
  const [au, av] = axes[ax]
  for (let k = 0; k < 3; k++) {
    const u = P[k][au] * TILES_PER_M
    const vv = P[k][av] * TILES_PER_M
    const kk = `${P[k][0].toFixed(5)},${P[k][1].toFixed(5)},${P[k][2].toFixed(5)},${nn[0].toFixed(3)},${nn[1].toFixed(3)},${nn[2].toFixed(3)},${u.toFixed(5)},${vv.toFixed(5)}`
    let id = g.seen.get(kk)
    if (id === undefined) {
      id = g.pos.length / 3
      g.seen.set(kk, id)
      g.pos.push(P[k][0], P[k][1], P[k][2])
      g.nor.push(nn[0], nn[1], nn[2])
      g.uv.push(u, vv)
    }
    g.idx.push(id)
  }
}

// ---------------------------------------------------------------------------
// сборка нового .glb
const chunks = []
let cursor = 0
const views = []
const accessors = []

function push(data, target) {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const padLen = (4 - (buf.length % 4)) % 4
  views.push({
    buffer: 0,
    byteOffset: cursor,
    byteLength: buf.length,
    ...(target ? { target } : {}),
  })
  chunks.push(buf)
  if (padLen) chunks.push(Buffer.alloc(padLen))
  cursor += buf.length + padLen
  return views.length - 1
}

function addAccessor(data, type, comps, componentType, target, minmax) {
  const view = push(data, target)
  const a = { bufferView: view, componentType, count: data.length / comps, type }
  if (minmax) {
    a.min = minmax[0]
    a.max = minmax[1]
  }
  accessors.push(a)
  return accessors.length - 1
}

const primitives = []
const materials = []
const stats = []
for (const [mat, g] of out) {
  const P = new Float32Array(g.pos)
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], P[i + k])
      hi[k] = Math.max(hi[k], P[i + k])
    }
  }
  const aPos = addAccessor(P, 'VEC3', 3, 5126, 34962, [lo, hi])
  const aNor = addAccessor(new Float32Array(g.nor), 'VEC3', 3, 5126, 34962)
  const aUv = addAccessor(new Float32Array(g.uv), 'VEC2', 2, 5126, 34962)
  const big = g.pos.length / 3 > 65535
  const aIdx = addAccessor(
    big ? new Uint32Array(g.idx) : new Uint16Array(g.idx),
    'SCALAR',
    1,
    big ? 5125 : 5123,
    34963,
  )
  materials.push({
    name: mat,
    doubleSided: true,
    pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 1 },
  })
  primitives.push({
    attributes: { POSITION: aPos, NORMAL: aNor, TEXCOORD_0: aUv },
    indices: aIdx,
    material: materials.length - 1,
  })
  stats.push({ материал: mat, треугольников: g.idx.length / 3, вершин: g.pos.length / 3 })
}

const nextJson = {
  asset: { version: '2.0', generator: 'Snowfall fireplace-retile' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0, name: 'Fireplace' }],
  meshes: [{ name: 'Fireplace', primitives }],
  materials,
  accessors,
  bufferViews: views,
}

// ---------------------------------------------------------------------------
// числа
console.log(`\nкамин: ${TRIS} треугольников, ${parts.size} деталей\n`)
console.log('  роли:', Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', '))
console.table(stats)

const trisOut = stats.reduce((s, r) => s + r.треугольников, 0)
const boxOut = (() => {
  const lo = [Infinity, Infinity, Infinity]
  const hi = [-Infinity, -Infinity, -Infinity]
  for (const [, g] of out) {
    for (let i = 0; i < g.pos.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], g.pos[i + k])
        hi[k] = Math.max(hi[k], g.pos[i + k])
      }
    }
  }
  return { lo, hi }
})()

let bad = 0
const claim = (ok, text, got) => {
  console.log(`  ${ok ? '✓' : '✗'} ${text}${got ? ' - ' + got : ''}`)
  if (!ok) bad++
}
console.log('\nпроверки:')
claim(trisOut === TRIS, 'ни одного треугольника не потеряно', `${trisOut} из ${TRIS}`)
const same = [0, 1, 2].every(
  (k) => Math.abs(boxOut.lo[k] - whole.lo[k]) < 1e-6 && Math.abs(boxOut.hi[k] - whole.hi[k]) < 1e-6,
)
claim(
  same,
  'габарит не сдвинулся ни на микрон (полость топки меряет firebox-check)',
  `x ${whole.lo[0].toFixed(3)}..${whole.hi[0].toFixed(3)}, y ${whole.lo[1].toFixed(3)}..${whole.hi[1].toFixed(3)}, z ${whole.lo[2].toFixed(3)}..${whole.hi[2].toFixed(3)}`,
)
claim(counts.beam > 0, 'полка нашлась', `${counts.beam} дет.`)
claim(counts.brick > 0, 'нутро топки нашлось', `${counts.brick} дет.`)
claim(counts.flue > 0, 'дымосборник нашёлся', `${counts.flue} дет.`)
claim(
  counts.rubble > 50,
  'кладка нашлась и осталась кладкой, а не одним куском',
  `${counts.rubble} дет.`,
)

// Плотность текселей - тем же счётом, что нашёл болезнь: площадь UV против
// площади в метрах. Обещание «512 пикселей на метр» должно быть посчитано, а не
// заявлено.
let a3 = 0
let a2 = 0
for (const [, g] of out) {
  for (let t = 0; t < g.idx.length / 3; t++) {
    const [i0, i1, i2] = [g.idx[t * 3], g.idx[t * 3 + 1], g.idx[t * 3 + 2]]
    const p = (i) => [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]]
    const [A, B, C] = [p(i0), p(i1), p(i2)]
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]]
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]]
    const cr = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]
    a3 += 0.5 * Math.hypot(...cr)
    const u = (i) => [g.uv[i * 2], g.uv[i * 2 + 1]]
    const [ua, ub, uc] = [u(i0), u(i1), u(i2)]
    a2 += 0.5 * Math.abs((ub[0] - ua[0]) * (uc[1] - ua[1]) - (uc[0] - ua[0]) * (ub[1] - ua[1]))
  }
}
const pxPerM = Math.sqrt(a2 / a3) * 512
claim(pxPerM > 400, `плотность при карте 512: ${pxPerM.toFixed(0)} px/м (было 56)`, '')

if (DRY) {
  console.log('\n  --dry: файл не тронут\n')
  process.exit(bad ? 1 : 0)
}
if (bad) {
  console.log('\n  претензии есть - файл не тронут\n')
  process.exit(1)
}

const size = writeGLB(GLB, nextJson, Buffer.concat(chunks))
// Перечитываем записанное: файл, который не открывается, лучше заметить здесь,
// а не в браузере.
const back = readGLB(GLB)
const backTris = back.json.meshes[0].primitives.reduce(
  (s, p) => s + back.json.accessors[p.indices].count / 3,
  0,
)
console.log(
  `\n  записано: ${(size / 1024).toFixed(0)} КБ (было ${(bytes / 1024).toFixed(0)} КБ), ` +
    `${backTris} треугольников, ${back.json.materials.length} материала, картинок ${(back.json.images || []).length}\n`,
)
