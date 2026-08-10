/**
 * Разбор и сборка .glb без зависимостей.
 *
 * Вынесено из `firebox-check.mjs`, когда тот же разбор понадобился второму
 * инструменту (`fireplace-retile.mjs`). Держать две копии чтения бинарного
 * формата - верный способ починить ошибку в одной из них.
 *
 * Зависимостей нет намеренно: оба инструмента разовые и запускаются руками, а
 * `@gltf-transform` в проекте живёт только как временная devDependency (см.
 * `repack-pines.mjs`). Ставить его ради чтения двух буферов не за что.
 */
import fs from 'node:fs'

const COMPS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }
const CSIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }

/**
 * Прочитать .glb: JSON, двоичный кусок и доступ к аксессорам по номеру.
 *
 * Аксессор отдаётся как `Float64Array` независимо от того, чем он был записан:
 * индексы бывают и 16-битные, и 32-битные, и арифметике всё равно, а вызывающему
 * коду разбираться в этом незачем.
 */
export function readGLB(file) {
  const buf = fs.readFileSync(file)
  const total = buf.readUInt32LE(8)
  let off = 12
  let json = null
  let bin = null
  while (off < total) {
    const len = buf.readUInt32LE(off)
    const kind = buf.readUInt32LE(off + 4)
    const body = buf.subarray(off + 8, off + 8 + len)
    if (kind === 0x4e4f534a) json = JSON.parse(body.toString('utf8'))
    else if (kind === 0x004e4942) bin = body
    off += 8 + len
  }
  const accessor = (i) => {
    const a = json.accessors[i]
    const v = json.bufferViews[a.bufferView]
    const start = (v.byteOffset || 0) + (a.byteOffset || 0)
    const comps = COMPS[a.type]
    const size = CSIZE[a.componentType]
    const stride = v.byteStride || size * comps
    const read = {
      5120: (o) => bin.readInt8(o),
      5121: (o) => bin.readUInt8(o),
      5122: (o) => bin.readInt16LE(o),
      5123: (o) => bin.readUInt16LE(o),
      5125: (o) => bin.readUInt32LE(o),
      5126: (o) => bin.readFloatLE(o),
    }[a.componentType]
    const out = new Float64Array(a.count * comps)
    for (let k = 0; k < a.count; k++) {
      for (let c = 0; c < comps; c++) out[k * comps + c] = read(start + k * stride + c * size)
    }
    return out
  }
  return { json, bin, accessor, bytes: buf.length }
}

/** Выровнять длину куска до четырёх байт - того требует формат. */
function pad(n) {
  return (4 - (n % 4)) % 4
}

/**
 * Записать .glb из готовых JSON и двоичного куска.
 *
 * Длину буфера в `json.buffers[0].byteLength` проставляет сама функция: разойдись
 * она с настоящей длиной - загрузчик читает мусор за краем, и валится это уже в
 * браузере, далеко от места ошибки.
 */
export function writeGLB(file, json, bin) {
  json.buffers = [{ byteLength: bin.length }]
  const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
  const jsonPad = Buffer.alloc(pad(jsonBuf.length), 0x20) // пробелы
  const binPad = Buffer.alloc(pad(bin.length), 0)
  const jsonLen = jsonBuf.length + jsonPad.length
  const binLen = bin.length + binPad.length
  const head = Buffer.alloc(12)
  head.writeUInt32LE(0x46546c67, 0) // glTF
  head.writeUInt32LE(2, 4)
  head.writeUInt32LE(12 + 8 + jsonLen + 8 + binLen, 8)
  const jsonHead = Buffer.alloc(8)
  jsonHead.writeUInt32LE(jsonLen, 0)
  jsonHead.writeUInt32LE(0x4e4f534a, 4)
  const binHead = Buffer.alloc(8)
  binHead.writeUInt32LE(binLen, 0)
  binHead.writeUInt32LE(0x004e4942, 4)
  const out = Buffer.concat([head, jsonHead, jsonBuf, jsonPad, binHead, bin, binPad])
  fs.writeFileSync(file, out)
  return out.length
}
