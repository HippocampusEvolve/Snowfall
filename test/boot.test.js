import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Заглушка страницы: только то, чем пользуется boot.js.
 *
 * Что здесь проверяется, а что нет. Контракт оболочки после 03.09.2026 такой:
 * до `unveil` кнопок на экране НЕТ (их прячет `body.booting`), а значит нет и
 * раннего нажатия, которое пришлось бы держать в очереди. Проверяем счётом
 * ровно это - разведение двух сигналов (`ready` и `unveil`), ход полосы и то,
 * что кнопки живут только после тумана. Само скрытие делает CSS, и оно живёт
 * в `index.html`; сюда доходит только класс на `body`.
 */
function page() {
  const nodes = new Map();
  const node = (id) => {
    const listeners = {};
    const el = {
      id,
      textContent: '',
      hidden: false,
      style: {},
      attrs: {},
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); },
        contains(c) { return this.set.has(c); },
      },
      setAttribute(k, v) { this.attrs[k] = v; },
      addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
      after() {},
      focus() {},
      click(ev = { type: 'click' }) { for (const fn of listeners.click || []) fn(ev); },
    };
    nodes.set(id, el);
    return el;
  };

  const body = node('body');
  body.className = '';

  global.document = {
    body,
    getElementById: (id) => nodes.get(id) || null,
    createElement: () => node('created'),
  };
  global.window = { addEventListener() {} };
  global.performance = { now: () => 0 };
  global.addEventListener = () => {};
  global.setTimeout = globalThis.setTimeout;
  global.location = { reload() {} };

  return {
    enter: node('enter'),
    reset: node('resetWorld'),
    gate: node('gate'),
    msg: node('bootMsg'),
    bar: node('loadBar'),
    fill: node('loadFill'),
    note: node('loadNote'),
    body,
  };
}

/** Ширина полосы в долях: то, что boot.js записал в DOM. */
const width = (dom) => parseFloat(dom.fill.style.width) / 100;

// --- кнопки принадлежат туману, а не экрану ---------------------------------

test('до готовности мира нажатие не делает ничего: кнопок на экране нет', async () => {
  const dom = page();
  await import('../public/boot.js?case=quiet');

  dom.enter.click({ type: 'click' });
  dom.reset.click();

  assert.equal(dom.body.classList.contains('unveiled'), false, 'войти было некуда');
  assert.equal(dom.body.classList.contains('booting'), true, 'экран всё ещё в загрузке');
});

test('пока идёт загрузка, на body висит booting - им и скрыты кнопки', async () => {
  page();
  await import('../public/boot.js?case=booting');
  assert.equal(global.document.body.classList.contains('booting'), true);
});

test('после готовности нажатие уходит прямо в мир и снимает туман', async () => {
  const dom = page();
  await import('../public/boot.js?case=direct');
  const boot = global.window.__FTE_BOOT__;

  const seen = [];
  assert.equal(boot.ready({ enter: (ev) => seen.push(ev) }), undefined, 'ready ничего не отдаёт');

  const press = { type: 'click', pointerType: 'mouse' };
  dom.enter.click(press);
  assert.deepEqual(seen, [press], 'нажатие должно уйти в мир как есть, без очереди');
  assert.equal(dom.body.classList.contains('unveiled'), true, 'вход всегда снимает туман');
});

test('«начать заново» после готовности зовёт обработчик мира', async () => {
  const dom = page();
  await import('../public/boot.js?case=reset');
  let called = 0;
  global.window.__FTE_BOOT__.ready({ reset: () => (called += 1) });
  dom.reset.click();
  assert.equal(called, 1);
});

// --- два сигнала: «мир встал на ноги» и «мир собран целиком» ----------------
// Туман экрана входа снимает не `ready`, а `unveil`. Разведены они затем, что
// `ready` мир зовёт по первому кадру, когда за меню ещё пусто, а отделка едет
// ещё две секунды. Проверяется счётом: это контракт оболочки, одинаковый во
// всех мирах, и глазами в браузере такое не ловится.

test('ready не снимает туман, а unveil снимает', async () => {
  page();
  await import('../public/boot.js?case=unveil');
  const boot = global.window.__FTE_BOOT__;
  const body = global.document.body;

  boot.ready({});
  assert.equal(body.classList.contains('unveiled'), false, 'мир ещё одевается - туман стоит');
  assert.equal(body.classList.contains('booting'), true, 'и мир за туманом не рисуется');

  boot.unveil();
  assert.equal(body.classList.contains('unveiled'), true, 'мир собран - туман расходится');
  assert.equal(body.classList.contains('booting'), false, 'теперь мир видно, значит и рисуем');
  assert.equal(body.classList.contains('ready'), true, 'полоса загрузки тает вместе с туманом');
});

test('unveil идемпотентен: сигналов к нему несколько', async () => {
  page();
  await import('../public/boot.js?case=unveil-twice');
  const boot = global.window.__FTE_BOOT__;
  boot.ready({});
  boot.unveil();
  boot.unveil();
  assert.equal(global.document.body.classList.contains('unveiled'), true);
});

// --- полоса -----------------------------------------------------------------
// Ход по кадрам на Node не воспроизвести (нет rAF), и boot.js это знает: без
// кадров он пишет ширину прямо в цель. Проверяем то, что от кадров не зависит:
// цель не ходит назад, до `unveil` не переваливает за 95 %, а на `unveil`
// доходит до края.

test('полоса идёт только вперёд и до тумана не доходит до конца', async () => {
  const dom = page();
  await import('../public/boot.js?case=bar');
  const boot = global.window.__FTE_BOOT__;

  const seen = [];
  for (const name of ['раз', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь']) {
    boot.mark(name);
    seen.push(width(dom));
  }
  boot.progress(0.2); // доля меньше хода по вехам - полоса не должна отступить
  seen.push(width(dom));

  for (let i = 1; i < seen.length; i += 1) {
    assert.ok(seen[i] >= seen[i - 1], `полоса пошла назад на шаге ${i}`);
  }
  assert.ok(seen.at(-1) <= 0.95, `до тумана полоса не идёт дальше 95 %, а дошла до ${seen.at(-1)}`);
  assert.equal(dom.bar.classList.contains('known'), true, 'ход известен - дыхание на CSS снято');

  boot.unveil();
  assert.equal(width(dom), 1, 'мир собран - полоса доходит до края');
});

test('доля загрузчика поднимает цель, если она выше хода по вехам', async () => {
  const dom = page();
  await import('../public/boot.js?case=progress');
  const boot = global.window.__FTE_BOOT__;
  boot.progress(1);
  assert.ok(width(dom) >= 0.94, `доли должны довести полосу почти до потолка, а дали ${width(dom)}`);
  boot.progress(-1); // мусор от загрузчика полосу не трогает
  assert.ok(width(dom) >= 0.94);
});

test('подпись этапа приходит из мира, а не из оболочки', async () => {
  const dom = page();
  await import('../public/boot.js?case=note');
  const boot = global.window.__FTE_BOOT__;

  boot.mark('мир собран');
  assert.equal(dom.note.textContent, '', 'без подписи оболочка ничего не выдумывает');

  boot.mark('лес собран', 'лес');
  // Смена идёт затуханием: текст встаёт после fade, класс снимается вместе с ним.
  assert.equal(dom.note.classList.contains('fading'), true);
  await new Promise((r) => globalThis.setTimeout(r, 320));
  assert.equal(dom.note.textContent, 'лес');
  assert.equal(dom.note.classList.contains('fading'), false);
});

// --- мир не собрался ---------------------------------------------------------

test('сторож ставит boot-failed и оставляет «повторить»', async () => {
  const dom = page();
  await import('../public/boot.js?case=fail');
  global.window.__FTE_BOOT__.fail(new Error('сеть'));

  assert.equal(dom.body.classList.contains('boot-failed'), true);
  assert.equal(dom.msg.hidden, false);
  assert.match(dom.msg.textContent, /не загрузился/);
  // Туман при этом НЕ снимается: показывать за ним нечего.
  assert.equal(dom.body.classList.contains('unveiled'), false);
});

test('после провала ready уже ничего не переигрывает', async () => {
  const dom = page();
  await import('../public/boot.js?case=fail-then-ready');
  const boot = global.window.__FTE_BOOT__;
  boot.fail(new Error('сеть'));
  boot.fail(new Error('и ещё раз'));
  assert.equal(dom.body.classList.contains('boot-failed'), true);
});
