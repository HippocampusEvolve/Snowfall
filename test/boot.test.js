import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Заглушка страницы: только то, чем пользуется boot.js. Нужна затем, что
 * главное свойство загрузчика - НЕ ТЕРЯТЬ нажатие, сделанное раньше, чем
 * собрался мир, - проверяется счётом, а не глазами в браузере.
 */
function page() {
  const nodes = new Map();
  const node = (id) => {
    const listeners = {};
    const el = {
      id,
      textContent: '',
      hidden: false,
      classList: {
        set: new Set(),
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); },
        contains(c) { return this.set.has(c); },
      },
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
  body.classList.add = function (c) { this.set.add(c); };

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

  return { enter: node('enter'), reset: node('resetWorld'), gate: node('gate'), msg: node('bootMsg') };
}

test('нажатие до готовности мира не пропадает, а ждёт его', async () => {
  const dom = page();
  dom.enter.textContent = 'войти в ночь';
  await import('../public/boot.js?case=pending');

  const press = { type: 'click', pointerType: 'mouse' };
  dom.enter.click(press);

  assert.ok(dom.enter.classList.contains('waiting'), 'кнопка должна показать, что нажатие принято');
  assert.equal(dom.enter.textContent, 'мир собирается');

  const had = global.window.__FTE_BOOT__.ready({});
  assert.equal(had.enter, press, 'мир должен получить то самое нажатие, а не флаг');
  assert.equal(dom.enter.classList.contains('waiting'), false, 'ожидание должно сняться');
  assert.equal(dom.enter.textContent, 'войти в ночь');
});

test('после готовности нажатие уходит прямо в мир', async () => {
  const dom = page();
  await import('../public/boot.js?case=direct');

  const seen = [];
  const had = global.window.__FTE_BOOT__.ready({ enter: (ev) => seen.push(ev) });
  assert.equal(had.enter, null, 'ничего не нажимали - нечего и отдавать');

  const press = { type: 'click', pointerType: 'mouse' };
  dom.enter.click(press);
  assert.deepEqual(seen, [press], 'нажатие должно уйти в мир сразу, без очереди');
  assert.equal(dom.enter.classList.contains('waiting'), false, 'ждать больше нечего');
});

test('«начать заново» до готовности мира тоже доживает', async () => {
  const dom = page();
  await import('../public/boot.js?case=reset');

  dom.reset.click();
  const had = global.window.__FTE_BOOT__.ready({});
  assert.equal(had.reset, true);
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

test('вход до конца отделки снимает туман вместе с собой', async () => {
  const dom = page();
  await import('../public/boot.js?case=unveil-pending');
  const boot = global.window.__FTE_BOOT__;

  dom.enter.click({ type: 'click' }); // нажали, пока мир собирался
  boot.ready({});
  assert.equal(
    global.document.body.classList.contains('unveiled'),
    true,
    'игрока нельзя оставить в мире за сплошным туманом'
  );
});

test('нажатие после ready тоже снимает туман, не дожидаясь отделки', async () => {
  const dom = page();
  await import('../public/boot.js?case=unveil-late');
  const boot = global.window.__FTE_BOOT__;

  boot.ready({ enter: () => {} });
  assert.equal(global.document.body.classList.contains('unveiled'), false);
  dom.enter.click({ type: 'click' });
  assert.equal(global.document.body.classList.contains('unveiled'), true);
});
