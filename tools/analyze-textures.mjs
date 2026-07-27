// Разведка перед пережатием: разрешение, альфа, разброс каналов.
// Малый stdev => карта почти константна и её можно заменить скаляром материала.
// Требует sharp (`npm i -D sharp`), в зависимостях проекта его нет.
// Пути ниже — исходные `textures/`, до перехода на `tex/` в v0.18.0.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const dirs = ['public/models/cabin/textures', 'public/models/pines/textures', 'public/textures'];
for (const d of dirs) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const img = sharp(p);
    const meta = await img.metadata();
    const st = await img.stats();
    const ch = st.channels.map((c) => `${c.mean.toFixed(0)}±${c.stdev.toFixed(1)}`).join(' ');
    console.log(
      `${(fs.statSync(p).size / 1024).toFixed(0).padStart(5)}K ${meta.width}x${meta.height} a=${meta.hasAlpha} [${ch}] ${f}`
    );
  }
  console.log('---');
}
