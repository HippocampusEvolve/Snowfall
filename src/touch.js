import { TouchControls, touchForced, touchSupported } from 'world-core/core';

// Тач-управление этого мира. Сам слой — в ядре (world-core/core): пальцы,
// оси, взгляд, кнопки как элементы. Здесь остаётся только то, что про
// Snowfall: какие кнопки бывают, как они выглядят и когда показываются.
// Раскладку в кадре им даёт CSS страницы по этим же id.

export { touchForced, touchSupported };

// Иконки: только штрих, без заливок и подложек — белые и тихие.
const ICONS = {
  // прыжок: стрелка отрывается от черты-земли
  jump: '<line x1="5" y1="20" x2="19" y2="20"/><polyline points="7.5 10.5 12 6 16.5 10.5"/><line x1="12" y1="6" x2="12" y2="16"/>',
  // рука-действие: точка в кольце — «взять/тронуть то, что перед тобой»
  act: '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="0.8"/>',
  // лопата: черенок с перекладиной и совок
  shovel: '<path d="M9.5 3h5"/><line x1="12" y1="3" x2="12" y2="12.5"/><path d="M8.5 12.5h7v3.2a3.5 3.5 0 0 1-7 0z"/>',
  // намыть: горка снега
  build: '<path d="M5 18a7 7 0 0 1 14 0"/><line x1="3.5" y1="18" x2="20.5" y2="18"/>',
  // топор: топорище и клин лезвия
  axe: '<line x1="6" y1="20.5" x2="14.2" y2="7.2"/><path d="M13 4.5 18.5 9c-1.7 1.1-3.3 1.4-5.2 1L11.6 7.6c.4-1.1 .8-2.1 1.4-3.1z"/>',
  // кирка: рукоять и два конца головки
  pickaxe: '<line x1="9" y1="21" x2="13" y2="7"/><path d="M4 8.5c4-3 11-3.5 16 .5M4 8.5l2.5-3M20 9l-2.5-3"/>',
  // молот: рукоять и боёк
  hammer: '<line x1="9" y1="21" x2="12" y2="9"/><path d="M5 6.5h13v5H5z"/>',
  torch: '<path d="M10 14h4l-1 7h-2zM12 3c1 4 5 5 4 8a4 4 0 0 1-8 0c-1-3 3-4 4-8z"/>',
};

/**
 * Прыжок висит всегда, «рука» — когда ею есть что сделать, кнопки инструмента
 * — когда он в руках. Что именно делают «рука» и инструмент, решает не тач:
 * обе кнопки уходят в тот же ввод, что клавиша F и кнопки мыши.
 */
export function createTouch(input, look, onTorch = () => {}) {
  const touch = new TouchControls({
    input,
    look,
    // касание кнопок оболочки (экран входа, экран смерти, выход на витрину)
    // не глушим — иначе не будет click
    passThrough: 'button, a, #gate, #death',
    buttons: [
      {
        id: 'tbJump',
        label: 'Прыгнуть',
        icon: ICONS.jump,
        shown: true,
        // держим факт нажатия — фронт ловит тело
        press: (down) => (input.touch.jump = down),
      },
      { id: 'tbAct', label: 'Взаимодействовать', icon: ICONS.act, press: (down) => down && input.pressAction() },
      { id: 'tbTorch', label: 'Достать факел', icon: ICONS.torch, press: (down) => down && onTorch() },
      // держать кнопку инструмента = держать ЛКМ/ПКМ: замахи цепочкой
      { id: 'tbTool1', label: 'Использовать инструмент', icon: ICONS.shovel, press: (down) => input.pressTool(1, down) },
      { id: 'tbTool2', label: 'Насыпать снег', icon: ICONS.build, press: (down) => input.pressTool(2, down) },
    ],
  });

  // видимость контекстных кнопок — из тика main.js
  let shown = null;
  let heldTorch = null;
  touch.setButtons = ({ action = false, tool = null, torch = false, torchHeld = false } = {}) => {
    touch.show('tbAct', action);
    touch.show('tbTorch', torch);
    if (heldTorch !== torchHeld) {
      heldTorch = torchHeld;
      touch.get('tbTorch').setAttribute('aria-label', torchHeld ? 'Поставить факел' : 'Взять факел');
    }
    if (tool === shown) return;
    shown = tool;
    touch.show('tbTool1', !!tool);
    touch.show('tbTool2', tool === 'shovel' || tool === 'axe');
    touch.setIcon('tbTool2', tool === 'axe' ? ICONS.axe : ICONS.build,
      tool === 'axe' ? 'Отделить строительное бревно' : 'Насыпать снег');
    const label = tool === 'axe'
      ? 'Рубить топором'
      : tool === 'pickaxe'
        ? 'Долбить киркой'
        : tool === 'hammer'
          ? 'Долбить молотом'
        : 'Копать лопатой';
    if (tool) touch.setIcon('tbTool1', ICONS[tool] || ICONS.shovel, label);
    else touch.get('tbTool1')?.setAttribute('aria-label', label);
  };

  return touch;
}
