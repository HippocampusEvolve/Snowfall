# Пропсы интерьера (drop-in)

Сюда кладём скачанные модели мебели/утвари для домика. Пока папка пустая —
интерьер рисуется процедурно (`buildInterior` в `src/cabin.js`): печь с чайником,
подвесной фонарь, стол со свечой, табуреты, кровать, поленница, полка, коврик.

## Что скачать (подходит под реализм-стиль игры)

**Poly Haven — CC0, без регистрации, сразу glTF/glb, оптимизировано:**
самый удобный источник, ничего указывать в титрах не нужно.

- Стол: `WoodenTable_02` / `WoodenTable_03` — https://polyhaven.com/a/WoodenTable_02
- Стул/табурет: `WoodenChair_01`, `chinese_stool`, `Rockingchair_01`
- Кровать: `GothicBed_01`
- Полка/комод: `Shelf_01`, `ClassicNightstand_01`
- Свет: `Lantern_01`, `brass_candleholders`, `Chandelier_01`
- Утварь: `brass_pot_01`, `brass_pan_01`, `book_encyclopedia_set_01`
- Бочки/ящики: `Barrel_01`, `Barrel_02`

Формат при скачивании выбирать **glTF** (или glb), разрешение текстур 1K–2K.

**Sketchfab — печь-буржуйка (в Poly Haven печей нет), CC-BY (нужны титры):**
- Cast-iron wood burning stove — https://sketchfab.com/3d-models/wood-burning-stove-fdb64e25fb4d4ccdad484339b89c9207
- Stove-Fireplace — https://sketchfab.com/3d-models/stove-fireplace-b78fba0979664bfcb8ae7742d7b45a73

## Как подключить

Положи распакованную модель в подпапку, например `props/stove/scene.gltf`,
и скажи мне — я пропишу загрузку в `cabin.js` (автомасштаб к реальному размеру,
посадка на пол raycast'ом, коллайдер) и уберу соответствующий процедурный примитив.
Модели CC-BY добавляй в `public/models/CREDITS.md`.
