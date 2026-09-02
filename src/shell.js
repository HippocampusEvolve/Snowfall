/**
 * shell.js — оболочка мира: экран входа, он же пауза.
 *
 * Одинакова во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с блоком «ОБОЛОЧКА МИРА» из `index.html` (docs/games.md витрины).
 * Правило простое: здесь только вход, пауза и выход — ни настроек, ни
 * счётчиков, ни списка клавиш.
 *
 * Экран этот НЕ ЖДЁТ МИРА и не принадлежит ему. Он нарисован разметкой и виден
 * с первой секунды; кнопки на нём живые сразу, потому что до прихода мира их
 * держит `boot.js`. Мир собирается за экраном и лишь забирает управление им,
 * когда встал на ноги, — вместе с тем, что успели нажать без него.
 *
 * Выход на витрину кода не требует вовсе: и стрелка в углу, и тихая ссылка
 * под кнопкой — обычные `<a>` в разметке. Отсюда только класс `paused` на
 * `body`, по которому стрелка и появляется.
 */

/**
 * @param {object} handlers
 * @param {(ev: Event) => void} handlers.onEnter вход в мир
 * @param {() => void}          handlers.onReset забыть мир и начать заново
 */
export function createShell({ onEnter, onReset }) {
  const gate = document.getElementById('gate');
  const button = document.getElementById('enter');

  return {
    /**
     * Мир собран: экран переходит от `boot.js` к нему.
     *
     * Возвращает то, что нажали, пока мир собирался: `{ enter, reset }`, где
     * `enter` — само событие нажатия (по нему мир узнаёт, чем вошли, пальцем
     * или мышью). Ждать этого нельзя было раньше и нельзя терять теперь.
     */
    ready() {
      return window.__FTE_BOOT__.ready({ enter: onEnter, reset: onReset });
    },
    /** Показать экран: на каждой паузе. До первого входа он и так открыт. */
    open() {
      gate.inert = false;
      gate.setAttribute('aria-hidden', 'false');
      gate.classList.remove('hidden');
      document.body.classList.add('paused');
      requestAnimationFrame(() => button.focus({ preventScroll: true }));
    },
    /** Убрать экран: игрок в мире. */
    close() {
      gate.classList.add('hidden');
      gate.inert = true;
      gate.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('paused');
      // После первого входа кнопка зовёт не в мир, а обратно в мир.
      if (button.dataset.resume) button.textContent = button.dataset.resume;
      document.body.tabIndex = -1;
      document.body.focus({ preventScroll: true });
    },
    /** Открыт ли экран сейчас. */
    isOpen() {
      return !gate.classList.contains('hidden');
    },
  };
}
