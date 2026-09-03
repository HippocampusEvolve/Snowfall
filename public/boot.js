// Этот файл намеренно лежит в public, а не в src: Vite не объединяет его с
// main.js. Если основной bundle не загрузится или не разберётся, watchdog уже
// работает и не оставит человека перед бесконечной полосой.
//
// Он же держит экран входа, пока мира ещё нет. Порядок такой: страница
// открывается сразу с меню, кнопка живая с первой секунды, а мир собирается
// за меню. Нажатие, пришедшее раньше готовности, не пропадает и не отвергается
// — оно ждёт здесь и уходит в мир первым делом, как только тот встал на ноги.

const gate = document.getElementById('gate');
const fog = document.getElementById('fog');
const bar = document.getElementById('loadBar');
const fill = document.getElementById('loadFill');
const enter = document.getElementById('enter');
const reset = document.getElementById('resetWorld');
const msg = document.getElementById('bootMsg');

const enterLabel = enter ? enter.textContent : ''; // «войти в ночь» - своё у мира

/** Сколько туман расходится, когда мир готов. Столько же стоит в CSS #fog. */
const UNVEIL_MS = 2000;

let ready = false; // мир собран и подхватил управление экраном
let unveiled = false; // туман разошёлся и открыл мир за меню
let pendingEnter = null; // событие нажатия «войти», пришедшее раньше мира
let pendingReset = false; // и «начать заново» тоже могли нажать раньше
let onEnter = null; // сюда мир кладёт свой обработчик, когда готов
let onReset = null;

document.body.classList.add('booting');
// Пока туман сплошной, мир за ним не виден - значит и рисовать его незачем.
// Класс снимается в `unveil`, а не в `ready`: между ними мир как раз и
// доодевается, и всё это время показывать его нечем и незачем.

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
    // Вход - это и есть конец ожидания: туман уходит вместе с ним, чем бы ни
    // была занята отделка. Иначе игрок оказался бы в мире за сплошной пеленой.
    unveil();
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

// ---------- полоса загрузки ----------
// Полоса ведётся ОТСЮДА и только отсюда. Раньше её вёл мир (`main.js`),
// считая ресурсы у общего загрузчика three, и до первого ресурса она просто
// «дышала» вслепую: человек видел движение, но не ход.
//
// Здесь у неё два источника, и берётся больший из них:
//   - ВЕХИ. Каждая веха - шаг лестницы с затуханием: 32, 54, 69, 79, 86, 91 %.
//     Вех у мира несколько, они разные у разных миров, и заранее их число
//     неизвестно - поэтому шаг не делит остаток поровну, а откусывает от него
//     треть. Полоса от этого никогда не упирается в конец раньше времени и
//     никогда не откатывается назад.
//   - ДОЛИ ЗАГРУЗЧИКА. Мир, начав считать ресурсы, зовёт `progress(доля)`;
//     это ровно то, что раньше писалось в полосу напрямую.
// Конец один: `ready()` доводит полосу до края, и она тает вместе с `#boot`.
let steps = 0;
let shown = 0;

/** Шаг лестницы вех: откусывает треть остатка, назад не ходит. */
function step() {
  steps += 1;
  paint(1 - Math.pow(0.68, steps));
}

function paint(value) {
  if (!bar || !fill || value <= shown) return;
  shown = value;
  bar.classList.add('known');
  fill.style.width = `${(shown * 100).toFixed(1)}%`;
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
  bar.setAttribute('aria-valuetext', `мир собран на ${Math.round(shown * 100)} процентов`);
}

/**
 * Туман расходится и открывает собранный мир за меню. Идемпотентно.
 *
 * Отделено от `ready` намеренно (03.09.2026). Раньше туман снимался прямо в
 * `ready`, а `ready` мир зовёт рано - по первому кадру, когда за меню стоит
 * ещё голая поляна, и следующие две секунды в кадре доезжали изба, лес и
 * мебель. Снаружи это читалось так: туман разошёлся и показал стройку, а
 * меню на ней подвисало - самые тяжёлые задачи главного потока приходились
 * ровно на эти две секунды.
 *
 * Теперь сигналов два. `ready` - «мир встал на ноги, кнопка теперь его», и
 * это ещё веха, а не конец: полоса делает шаг. `unveil` - «мир собран
 * целиком», и вот здесь полоса доходит до края, тает вместе с `#boot`, а
 * туман расступается. Не путать с пробуждением (`awaken.js`): там просыпается
 * мир, здесь расступается подложка меню.
 */
function unveil() {
  if (unveiled) return;
  unveiled = true;
  paint(1);
  document.body.classList.remove('booting');
  document.body.classList.add('unveiled');
  document.body.classList.add('ready');
  setTimeout(() => fog?.classList.add('gone'), UNVEIL_MS);
}

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
    // Веха, а не конец: мир подхватил экран, но отделка ещё едет. Туман
    // снимает `unveil`, и до него полоса до края не доходит.
    step();
    onEnter = handlers.enter || null;
    onReset = handlers.reset || null;
    // Кнопка возвращается из ожидания: если нажатие было, мир отработает его
    // сам, а надпись должна снова звать внутрь.
    if (enter) {
      enter.classList.remove('waiting');
      enter.textContent = enterLabel;
    }
    const had = { enter: pendingEnter, reset: pendingReset };
    pendingEnter = null;
    pendingReset = false;
    // Нажали раньше, чем мир оделся: игрока нельзя оставить за туманом.
    // Вход всегда снимает туман, даже если мир ещё договаривает отделку.
    if (had.enter) unveil();
    return had;
  },
  /** Мир собран целиком: туман расходится. См. `unveil` выше. */
  unveil,
  /** Виден ли ещё экран входа: миру это нужно, чтобы не входить дважды. */
  gateOpen() {
    return !!gate && !gate.classList.contains('hidden');
  },
  /** Отметить веху загрузки. Полоса при этом делает шаг: см. `paint`. */
  mark(name) {
    trace.push([name, Math.round(performance.now())]);
    step();
  },
  /**
   * Доля загруженного по счёту ресурсов: 0..1. Зовёт мир, когда его загрузчик
   * знает доли. Полоса берёт большее из этого и хода по вехам.
   */
  progress(fraction) {
    if (!(fraction >= 0)) return;
    paint(0.35 + 0.6 * Math.min(1, fraction));
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
