// Этот файл намеренно лежит в public, а не в src: Vite не объединяет его с
// main.js. Если основной bundle не загрузится или не разберётся, watchdog уже
// работает и не оставит человека перед бесконечной полосой.
//
// Он же держит экран входа, пока мира ещё нет. Порядок такой: страница
// открывается сразу с меню, кнопка живая с первой секунды, а мир собирается
// за меню. Нажатие, пришедшее раньше готовности, не пропадает и не отвергается
// — оно ждёт здесь и уходит в мир первым делом, как только тот встал на ноги.

const gate = document.getElementById('gate');
const enter = document.getElementById('enter');
const reset = document.getElementById('resetWorld');
const msg = document.getElementById('bootMsg');

const enterLabel = enter ? enter.textContent : ''; // «войти в ночь» - своё у мира

let ready = false; // мир собран и подхватил управление экраном
let pendingEnter = null; // событие нажатия «войти», пришедшее раньше мира
let pendingReset = false; // и «начать заново» тоже могли нажать раньше
let onEnter = null; // сюда мир кладёт свой обработчик, когда готов
let onReset = null;

document.body.classList.add('booting');

function fail(reason) {
  if (ready) return;
  ready = true;
  console.error('мир не собрался:', reason);
  document.body.classList.add('boot-failed');
  if (msg) {
    msg.textContent = 'Мир не загрузился. Проверь сеть и попробуй снова';
    msg.hidden = false;
  }
  if (!document.getElementById('bootRetry')) {
    const retry = document.createElement('button');
    retry.id = 'bootRetry';
    retry.type = 'button';
    retry.className = 'btn';
    retry.textContent = 'повторить';
    retry.addEventListener('click', () => location.reload());
    enter?.after(retry);
    retry.focus({ preventScroll: true });
  }
}

// Кнопка входа принимает нажатие ВСЕГДА. До готовности мира она переходит в
// ожидание: гаснет, перестаёт ловить второе нажатие и ждёт мир. Отказывать
// нажатию нельзя - именно это и читалось как «кнопка не работает».
enter?.addEventListener('click', (ev) => {
  if (onEnter) {
    onEnter(ev);
    return;
  }
  if (pendingEnter) return;
  // Держим САМО событие, а не флаг: по нему мир поймёт, чем вошли, пальцем
  // или мышью, и это решает, запрашивать ли захват курсора.
  pendingEnter = ev;
  enter.classList.add('waiting');
  enter.textContent = 'мир собирается';
});

// «Начать ночь заново» до готовности мира тоже не пропадает: память мира
// чистит `save.js`, а он приезжает с бандлом.
reset?.addEventListener('click', () => {
  if (onReset) {
    onReset();
    return;
  }
  pendingReset = true;
});

const watchdog = setTimeout(() => fail(new Error('загрузка не уложилась в 30 с')), 30000);

// Трасса загрузки: пара чисел на весь мир, зато загрузку больше не измеряют на
// глаз. Метки ставит main.js в узловых точках (мир собран, меню открыто,
// отделка приехала), снять их можно откуда угодно, включая прод:
// `copy(__FTE_BOOT__.trace())` в консоли.
const trace = [];

window.__FTE_BOOT__ = {
  /**
   * Мир собран и берёт экран входа на себя.
   *
   * @param {object} [handlers]
   * @param {(ev: Event) => void} [handlers.enter] вход в мир
   * @param {() => void}          [handlers.reset] забыть мир и начать заново
   * @returns {{ enter: Event|null, reset: boolean }} что нажали, пока он собирался
   */
  ready(handlers = {}) {
    ready = true;
    clearTimeout(watchdog);
    onEnter = handlers.enter || null;
    onReset = handlers.reset || null;
    document.body.classList.remove('booting');
    document.body.classList.add('ready');
    // Кнопка возвращается из ожидания: если нажатие было, мир отработает его
    // сам, а надпись должна снова звать внутрь.
    if (enter) {
      enter.classList.remove('waiting');
      enter.textContent = enterLabel;
    }
    const had = { enter: pendingEnter, reset: pendingReset };
    pendingEnter = null;
    pendingReset = false;
    return had;
  },
  /** Виден ли ещё экран входа: миру это нужно, чтобы не входить дважды. */
  gateOpen() {
    return !!gate && !gate.classList.contains('hidden');
  },
  /** Отметить веху загрузки. */
  mark(name) {
    trace.push([name, Math.round(performance.now())]);
  },
  /** Снять трассу: пары «веха, миллисекунды от открытия страницы». */
  trace() {
    return trace.slice();
  },
  /** Мир не собрался. Зовётся и отсюда, и снаружи. */
  fail,
};

addEventListener('error', (event) => fail(event.error || new Error('ресурс не загрузился')), true);
addEventListener('unhandledrejection', (event) => fail(event.reason));
