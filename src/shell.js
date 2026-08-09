/**
 * shell.js — оболочка мира: экран входа, он же пауза.
 *
 * Одинакова во всех мирах find-the-end.fun и переносится в новый мир копией
 * вместе с блоком «ОБОЛОЧКА МИРА» из `index.html` (docs/games.md витрины).
 * Правило простое: здесь только вход, пауза и выход — ни настроек, ни
 * счётчиков, ни списка клавиш.
 *
 * Выход на витрину кода не требует вовсе: и стрелка в углу, и тихая ссылка
 * под кнопкой — обычные `<a>` в разметке. Отсюда только класс `paused` на
 * `body`, по которому стрелка и появляется.
 */

export function createShell(onEnter) {
  const gate = document.getElementById('gate');
  const button = document.getElementById('enter');

  // Событие клика уходит наружу целиком: по нему мир узнаёт, чем именно вошли
  // — пальцем или мышью. Наличие тачскрина об этом не говорит ничего: у
  // ноутбука с сенсорным экраном есть и то, и другое.
  button.addEventListener('click', (ev) => onEnter(ev));

  return {
    /** Показать экран: до первого входа и на каждой паузе. */
    open() {
      gate.classList.remove('hidden');
      document.body.classList.add('paused');
    },
    /** Убрать экран: игрок в мире. */
    close() {
      gate.classList.add('hidden');
      document.body.classList.remove('paused');
      // После первого входа кнопка зовёт не в мир, а обратно в мир.
      if (button.dataset.resume) button.textContent = button.dataset.resume;
    },
  };
}
