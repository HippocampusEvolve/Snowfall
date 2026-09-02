import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConst } from 'node:zlib';
import { defineConfig } from 'vite';

// ---------------------------------------------------------------------------
// Штампы версий для файлов из public/
//
// Бандл Vite несёт хэш прямо в имени: поменялось содержимое — поменялось имя,
// и браузер скачивает новое. У моделей и текстур имена постоянные, а nginx
// отдаёт их с `Cache-Control: immutable` на год. Immutable — это не «храни
// подольше», это «даже не спрашивай, изменилось ли»: вернувшийся игрок ещё год
// видит ту версию, что скачал в первый раз. Камин в избе так и простоял целую
// выкладку — на сервере новая модель, в браузере старая, и по картинке не
// отличить, потому что оба файла лежат по одному адресу.
//
// Плагин считает хэш каждого файла в public/ и отдаёт таблицу бандлу. Адрес
// становится `models/props/fireplace.glb?v=1a2b3c4d`, и это ключ браузерного
// кэша: правка одного файла обновляет ровно его, остальные семь мегабайт
// остаются лежать скачанными. Immutable при этом из ловушки превращается в то,
// чем и должен быть.
//
// В dev таблица пустая: там свои правила кэша, а хэш всё равно устаревал бы до
// перезапуска сервера.
// ---------------------------------------------------------------------------
const VIRTUAL = 'virtual:asset-stamps';

function stampsOf(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      // Восемь знаков sha1 — это 4 миллиарда вариантов на 65 файлов. Совпадение
      // двух версий ОДНОГО файла и есть тот случай, когда перекачивать нечего.
      else out[relative(dir, path).split(sep).join('/')] =
        createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 8);
    }
  };
  walk(dir);
  return out;
}

export function assetStamps(dir = 'public') {
  let stamps = {};
  let live = false;
  return {
    name: 'asset-stamps',
    configResolved(config) {
      live = config.command === 'build';
    },
    buildStart() {
      stamps = live ? stampsOf(dir) : {};
      if (live) console.log(`[stamps] ${Object.keys(stamps).length} файлов из ${dir}/`);
    },
    resolveId(id) {
      return id === VIRTUAL ? `\0${VIRTUAL}` : null;
    },
    load(id) {
      return id === `\0${VIRTUAL}` ? `export default ${JSON.stringify(stamps)}` : null;
    },
  };
}

// es2022 — из-за top-level await в main.js (загрузка моделей до старта цикла).
// Проекту и так нужен современный браузер (WebGL2, pointer lock).
// ---------------------------------------------------------------------------
// Service worker: второй приход в мир без сети.
//
// Плагин читает `sw-template.js` из корня игры, подставляет в него базовый
// путь, версию сборки и список файлов оболочки, и кладёт готовый `sw.js`
// рядом с бандлом. Сам шаблон в сборку не импортируется - иначе Vite разобрал
// бы его как модуль страницы, а он исполняется в worker'е.
//
// Версия считается по ИМЕНАМ бандлов, а они несут хэш содержимого: изменилась
// хоть строчка в мире - изменилось имя, значит и версия. Штампы файлов из
// public/ тоже лежат внутри бандла (см. assetStamps выше), так что новая
// текстура меняет версию ровно так же, как новый код.
//
// В dev плагин молчит: там нет ни бандлов, ни постоянных имён, а закэшированный
// worker'ом dev-сервер - это полдня поиска того, почему правка не видна.
// ---------------------------------------------------------------------------
export function serviceWorker() {
  let base = '/';
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      base = config.base;
    },
    generateBundle(_options, bundle) {
      const scripts = Object.keys(bundle)
        .filter((f) => f.endsWith('.js'))
        .sort();
      // Оболочка: сама страница, отдельный boot и бандлы. Модели и текстуры
      // сюда НЕ входят - их кэширует worker по факту запроса (sw-template.js).
      const shell = [base, `${base}boot.js`, ...scripts.map((f) => base + f)];
      const version = createHash('sha1').update(scripts.join('|')).digest('hex').slice(0, 8);
      const source = readFileSync(new URL('./sw-template.js', import.meta.url), 'utf8')
        .replace(/__SCOPE__/g, base)
        .replace(/__VERSION__/g, version)
        .replace(/__SHELL__/g, JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
      console.log(`[sw] версия ${version}, оболочка из ${shell.length} файлов`);
    },
  };
}

// ---------------------------------------------------------------------------
// Предсжатие: brotli кладётся рядом с файлами прямо в сборке.
//
// Простая идея. Раньше nginx жал каждый ответ заново — на каждый запрос, для
// каждого посетителя. Бандл three.js это 559 КБ, и сжать их brotli даже на
// щадящем уровне стоит времени: на прогретом соединении файл начинал уходить
// через 120-180 мс, тогда как несжимаемый scene.bin рядом — через 70. Разница
// и есть работа сжатия, и на одноядерной машине она умножается на число
// пришедших разом.
//
// Сжать один раз при сборке — значит не платить ни разу при раздаче. Заодно
// становится доступен brotli 11: на лету такой уровень не включают, он слишком
// медленный, а в сборке лишние секунды никого не трогают. Бандл движка выходит
// 118 КБ вместо 132.
//
// На сервере это включается директивой `brotli_static on`
// (ops/hardening/13-nginx.sh): nginx сам смотрит, лежит ли рядом с файлом
// `.br`, и отдаёт его вместо того, чтобы жать. Не лежит — жмёт по-старому,
// поэтому сборка без предсжатия остаётся рабочей.
//
// Спутника для gzip не кладём. Он весил бы ещё две с половиной сотни
// килобайт на каждую выкладку ради браузеров, которые не понимают brotli, а
// таких среди живых не осталось: Chrome понимает с 2016 года, Safari с 2017.
// Тому единственному, кто придёт без brotli, nginx сожмёт gzip'ом на лету,
// как и раньше.
//
// Сжимаем и модели: `.glb` и `.bin` отдаются как application/octet-stream,
// и в списки типов для сжатия на лету этот тип не входит намеренно —
// пропускать через brotli полуторамегабайтный буфер на каждый запрос было бы
// хуже, чем не сжимать вовсе. А один раз при сборке — можно, и там, где файл
// от этого выигрывает (камин: 180 -> 50 КБ), выигрыш достаётся даром.
// ---------------------------------------------------------------------------

// Форматы, которые уже сжаты внутри себя: второй проход даёт проценты, а
// место и время занимает целиком. Draco-геометрия сюда не входит осознанно —
// она в .bin и .glb, и по ним решает не расширение, а замер ниже.
const PACKED = new Set([
  '.webp', '.png', '.jpg', '.jpeg', '.avif', '.gif',
  '.mp4', '.webm', '.mp3', '.ogg', '.woff', '.woff2',
  '.br', '.gz', '.zip',
]);

// Ниже килобайта сжимать нечего: ответ и так уходит одним пакетом. То же
// число стоит в gzip_min_length и brotli_min_length на сервере.
const MIN_SIZE = 1024;

// Класть спутника рядом стоит, только если он заметно легче оригинала. Иначе
// в сборке появляется файл, ради которого nginx делает лишний stat, а
// посетитель экономит полпроцента. Пять процентов — та граница, ниже которой
// выигрыш перестаёт стоить второго файла.
const MIN_WIN = 0.95;

const brotliAsync = promisify(brotliCompress);

export function precompress() {
  let outDir = 'dist';
  return {
    name: 'precompress',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    // closeBundle, а не writeBundle: public/ Vite копирует позже бандла, и в
    // writeBundle моделей на диске ещё нет.
    async closeBundle() {
      const files = [];
      const walk = (dir) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          const st = statSync(path);
          if (st.isDirectory()) walk(path);
          else if (st.size >= MIN_SIZE && !PACKED.has(name.slice(name.lastIndexOf('.'))))
            files.push({ path, size: st.size });
        }
      };
      walk(outDir);

      let raw = 0;
      let packed = 0;
      let made = 0;
      await Promise.all(
        files.map(async (file) => {
          const data = readFileSync(file.path);
          const br = await brotliAsync(data, {
            params: {
              [zlibConst.BROTLI_PARAM_QUALITY]: 11,
              [zlibConst.BROTLI_PARAM_SIZE_HINT]: data.length,
            },
          });
          if (br.length > data.length * MIN_WIN) return;
          writeFileSync(`${file.path}.br`, br);
          raw += data.length;
          packed += br.length;
          made += 1;
        })
      );
      const mb = (n) => (n / 1048576).toFixed(2);
      console.log(
        `[precompress] ${made} файлов: ${mb(raw)} -> ${mb(packed)} МБ brotli ` +
          `(-${raw ? (100 - (packed / raw) * 100).toFixed(0) : 0}%)`
      );
    },
  };
}

// base: прод-сборка живёт на https://find-the-end.fun/snowfall/, dev — на корне
// (пути ассетов в коде идут через src/asset.js -> import.meta.env.BASE_URL).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/snowfall/' : '/',
  // Ядро миров (world-core) держит свой three в devDependencies, и он новее
  // нашего. Без dedupe сборщик взял бы обе копии сразу: у three всё построено
  // на instanceof и на общих реестрах, поэтому две копии — это материалы,
  // группы и геометрии, которые перестают узнавать друг друга, и вторые
  // шестьсот килобайт в бандле заодно. Ядро объявляет three как
  // peerDependency: копия должна быть ровно одна, наша.
  resolve: { dedupe: ['three'] },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        // three отдельным файлом от кода мира. Раньше они лежали вместе, и
        // правка одной строки в игре меняла имя всего бандла: вернувшийся
        // игрок перекачивал шестьсот килобайт движка, который не менялся
        // месяцами. Теперь выкладка правит только свой кусок.
        manualChunks: { three: ['three'] },
      },
    },
  },
  // precompress последним: он обходит готовую сборку, значит sw.js уже
  // выпущен, а public/ скопирован.
  plugins: [assetStamps(), serviceWorker(), precompress()],
}));
