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
