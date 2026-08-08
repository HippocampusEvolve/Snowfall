import { DefaultLoadingManager } from 'three';
import stamps from 'virtual:asset-stamps';

// URL ассета с учётом базового пути сборки: в dev это '/', в прод-сборке —
// '/snowfall/' (игра живёт в подкаталоге find-the-end.fun, см. vite.config.js).
//
// ---- почему к адресу приклеивается ?v= ----
//
// Модели и текстуры лежат в public/ и попадают в сборку под своими именами, без
// хэша. Отдаёт их nginx с `Cache-Control: immutable` на год, а immutable — это
// не «храни подольше», это «даже не переспрашивай». Вернувшийся игрок ещё год
// видит ту версию, что скачал в первый раз, и никакая выкладка этого не
// меняет: адрес-то прежний. Камин в избе так и простоял целую выкладку — на
// сервере новая модель, в браузере старая, и по картинке не отличить.
//
// Штамп — восемь знаков хэша содержимого, их считает плагин в vite.config.js
// при сборке. Адрес меняется вместе с файлом, и это ключ браузерного кэша:
// правка одной модели обновляет ровно её, остальные семь мегабайт остаются
// скачанными. В dev таблица пустая и адреса чистые.
const BASE = import.meta.env.BASE_URL;

const key = (url) => (url.startsWith(BASE) ? url.slice(BASE.length) : url.replace(/^\//, ''));

export function stampUrl(url) {
  if (typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) return url;
  const path = key(url).split('?')[0];
  const stamp = stamps[path];
  if (!stamp || /[?&]v=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}v=${stamp}`;
}

export const asset = (p) => stampUrl(BASE + p.replace(/^\//, ''));

// Штампуем не только то, что просят через asset(). Внутри `scene.gltf` лежат
// свои ссылки — на `scene.bin` и на каждую текстуру, — и их разворачивает сам
// GLTFLoader, мимо нашего кода. Так же грузится декодер Draco. Всё это идёт
// через один общий DefaultLoadingManager, поэтому достаточно одного
// перехватчика: он видит каждый адрес, который three.js собирается запросить.
//
// Ставится при импорте модуля, а не по вызову из main.js, и это намеренно.
// asset.js импортируют все, кто грузит, - значит по правилам модулей он
// выполнится раньше любого из них. Явный вызов пришлось бы держать выше
// первой загрузки вручную, и он пережил бы ровно до первой перестановки строк.
DefaultLoadingManager.setURLModifier(stampUrl);
