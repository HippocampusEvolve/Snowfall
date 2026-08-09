import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
// base: прод-сборка живёт на https://find-the-end.fun/snowfall/, dev — на корне
// (пути ассетов в коде идут через src/asset.js -> import.meta.env.BASE_URL).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/snowfall/' : '/',
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
  plugins: [assetStamps()],
}));
