// Draco для предметов, которые приехали без него.
//
// Простая идея. Draco — это архиватор, который понимает, что внутри лежит не
// байты, а треугольники: вместо трёх честных чисел с плавающей точкой на
// координату он хранит номер в сетке нужной плотности и разницу с соседом.
// Пятитысячевершинный камин ужимается вчетверо, и три четверти файла
// исчезают ещё до того, как за него возьмётся brotli.
//
// Почему не всё подряд. В Snowfall Draco есть у сосен, домика, камней и книг,
// а три предмета из `props/` его миновали: камин, кострище и лопата. Декодер
// (192 КБ wasm) в сборку и так едет ради остальных, так что за эти три файла
// мы уже заплатили — не пользоваться им просто нечем оправдать.
//
// Что здесь важно понимать про потери. Draco квантует: непрерывную координату
// он кладёт на сетку, и чем меньше бит, тем сетка грубее. Сетка считается от
// габарита самого предмета, поэтому одно и то же число бит для сосны в
// пятнадцать метров и для лопаты в метр даёт совершенно разную точность.
// Четырнадцать бит на позицию — это габарит, делённый на 16384: для камина
// высотой полтора метра выходит девять сотых миллиметра. Камин доводили с
// точностью 56 пикселей на метр, то есть около восемнадцати миллиметров;
// девять сотых миллиметра меньше этого в двести раз.
//
// Но верить расчёту мало, поэтому каждый предмет обмеряется до и после:
// габариты по осям, число треугольников и суммарная площадь поверхности.
// Площадь — самая чувствительная из трёх: сдвинь любую вершину, и она
// поедет, даже если габариты и счёт треугольников сойдутся. Расхождение
// больше сотой доли процента считается провалом, и файл не записывается.
//
// Разовый инструмент, в зависимостях проекта не держим (см. repack-pines.mjs):
//   npm i -D @gltf-transform/core @gltf-transform/extensions \
//            @gltf-transform/functions draco3dgltf
//   node tools/draco-props.mjs           # разведка, файлы не трогаются
//   node tools/draco-props.mjs --apply   # записать
//
// Повторный прогон по уже сжатому файлу копит ошибку квантования — если
// понадобится переделать, берите исходник из истории git.
import fs from 'node:fs'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, draco, weld } from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'

const FILES = [
  'public/models/props/fireplace.glb',
  'public/models/props/firepit.glb',
  'public/models/props/shovel.glb',
]

// Биты квантования позиции. Перебираются снизу вверх: берётся первое
// значение, на котором обмер сходится.
//
// Перебор здесь не от лени, а потому что число бит нельзя назначить одно на
// всех. Draco считает сетку от наибольшего габарита предмета, а лопата
// длинная и узкая: 1.45 м в длину и 0.2 м в ширину. Четырнадцать бит дают
// шаг 0.088 мм — по длине это ничтожные 0.006%, а по ширине уже 0.044%, и
// площадь поверхности уезжает за допуск. Порог при этом верный, и трогать
// его нельзя; правильно поднять точность там, где предмет её требует.
// Камину и кострищу хватает четырнадцати, лопате нужно пятнадцать, и пусть
// это решает обмер, а не наша память.
const POSITION_BITS = [12, 13, 14, 15, 16]

// Остальные атрибуты грубее намеренно: нормаль и развёртка терпят куда
// больше позиции, и на них глаз не ловит разницы вовсе.
const QUANT = {
  quantizeNormal: 10,
  quantizeTexcoord: 12,
  quantizeColor: 8,
  quantizeGeneric: 12,
}

// Насколько обмер после сжатия вправе разойтись с обмером до, в процентах.
// Не «сколько не жалко», а «сколько объяснимо квантованием»: при 14 битах
// вершина съезжает на габарит/16384, то есть на 0.006% размера предмета, и
// площадь не может поехать заметно сильнее. Сотая доля процента — это уже
// с запасом впятеро.
const TOLERANCE = 0.01

const APPLY = process.argv.includes('--apply')

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.encoder': await draco3d.createEncoderModule(),
  'draco3d.decoder': await draco3d.createDecoderModule(),
})

/**
 * Обмер документа: габариты, треугольники, площадь поверхности.
 *
 * Считается по всем примитивам сразу, в координатах меша — мировые
 * преобразования узлов здесь не нужны, сжатие их не трогает.
 */
function measure(doc) {
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  let tris = 0
  let area = 0
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      if (!pos) continue
      const p = pos.getArray()
      for (let i = 0; i < p.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          if (p[i + k] < box[k]) box[k] = p[i + k]
          if (p[i + k] > box[3 + k]) box[3 + k] = p[i + k]
        }
      }
      const idx = prim.getIndices()
      const list = idx ? idx.getArray() : null
      const count = list ? list.length : p.length / 3
      for (let i = 0; i + 2 < count; i += 3) {
        const a = (list ? list[i] : i) * 3
        const b = (list ? list[i + 1] : i + 1) * 3
        const c = (list ? list[i + 2] : i + 2) * 3
        // Площадь треугольника — половина длины векторного произведения
        // двух его сторон. Ни к какой оси не привязана, значит поймает
        // смещение вершины в любую сторону.
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2]
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2]
        const cx = uy * vz - uz * vy
        const cy = uz * vx - ux * vz
        const cz = ux * vy - uy * vx
        area += Math.hypot(cx, cy, cz) / 2
        tris += 1
      }
    }
  }
  return {
    size: [box[3] - box[0], box[4] - box[1], box[5] - box[2]],
    tris,
    area,
  }
}

const pct = (a, b) => (b === 0 ? 0 : Math.abs((a - b) / b) * 100)
const kb = (n) => (n / 1024).toFixed(0).padStart(4) + ' КБ'
const m3 = (s) => s.map((v) => v.toFixed(4)).join(' x ')

console.log(
  `\nDraco для предметов: позиция ${QUANT.quantizePosition} бит, ` +
    `допуск обмера ${TOLERANCE}%\n`
)

let before = 0
let after = 0
let failed = 0

for (const file of FILES) {
  const wasSize = fs.statSync(file).size
  before += wasSize

  const was = measure(await io.read(file))
  console.log(`${file.split('/').pop()}  ${kb(wasSize)}`)

  let best = null
  for (const bits of POSITION_BITS) {
    // Документ читается заново под каждую попытку: transform правит его на
    // месте, и второй проход шёл бы уже по сжатому.
    const doc = await io.read(file)
    // weld склеивает вершины, совпавшие по всем атрибутам, dedup убирает
    // повторяющиеся аксессоры и материалы. Обе нужны до Draco: он кодирует
    // связность, и чем она честнее, тем плотнее выходит.
    await doc.transform(weld(), dedup(), draco({ ...QUANT, quantizePosition: bits }))

    const packed = await io.writeBinary(doc)
    // Перечитываем то, что получилось, а не то, что задумали: обмер должен
    // идти по разжатому файлу, иначе он проверяет наши намерения, а не Draco.
    const back = measure(await io.readBinary(packed))

    const dSize = was.size.map((v, i) => pct(back.size[i], v))
    const dArea = pct(back.area, was.area)
    const ok =
      back.tris === was.tris && dArea <= TOLERANCE && dSize.every((d) => d <= TOLERANCE)

    console.log(
      `   ${bits} бит  ${kb(packed.length)}  габарит ` +
        `${dSize.map((d) => d.toFixed(4) + '%').join(' / ')}` +
        `  площадь ${dArea.toFixed(4)}%  треуг ${back.tris}` +
        `  ${ok ? 'сходится' : '—'}`
    )
    if (ok) {
      best = { bits, packed, back, dArea, dSize }
      break
    }
  }

  if (!best) {
    console.log('   ОБМЕР НЕ СОШЁЛСЯ НИ НА ОДНОЙ ТОЧНОСТИ — файл не записываем\n')
    failed += 1
    after += wasSize
    continue
  }

  const { packed, back } = best
  console.log(`   габарит  ${m3(was.size)} м  ->  ${m3(back.size)} м`)
  console.log(`   площадь  ${was.area.toFixed(5)} -> ${back.area.toFixed(5)} м²`)

  if (packed.length >= wasSize) {
    // Так уже бывало: на домике Snowfall draco() оставлял геометрию
    // несжатой, и файл раздувался впятеро (см. repack-pines.mjs).
    console.log('   после сжатия не легче — файл не записываем\n')
    after += wasSize
    continue
  }
  console.log(`   в порядке, -${(100 - (packed.length / wasSize) * 100).toFixed(0)}%\n`)
  after += packed.length
  if (APPLY) fs.writeFileSync(file, packed)
}

console.log(
  `Итого: ${(before / 1024).toFixed(0)} -> ${(after / 1024).toFixed(0)} КБ` +
    (failed ? `, не прошли обмер: ${failed}` : '')
)
console.log(
  APPLY
    ? 'Файлы записаны. Дальше — npm run build и проверка мира счётом.\n'
    : 'Это разведка. Записать: node tools/draco-props.mjs --apply\n'
)
