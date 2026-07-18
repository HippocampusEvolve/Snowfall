# Деплой Snowfall на VPS

## Чеклист релиза (каждая новая версия)

1. Запись в `CHANGELOG.md` + поднять `version` в `package.json`
2. Закоммитить и запушить на GitHub: `git add -A && git commit && git push`
3. Обновить прод: `npm run build` + залить `dist/` на сервер
   (однострочник — в `deploy/LOCAL.md`)
4. Открыть прод-ссылку, убедиться что игра грузится без ошибок

GitHub и сервер друг про друга не знают: пуш не обновляет сайт, деплой
не обновляет репозиторий — нужны оба шага.

Игра — чистая статика: серверная часть не нужна, только веб-сервер.
Весь первичный трафик ~21 МБ на игрока (модели пережаты WebP+Draco),
дальше всё берётся из кэша браузера.

## Вариант: путь /snowfall/ на существующем сайте

Так игра развёрнута на https://antonov-ai.ru/snowfall/. Vite `base`
задаётся в `vite.config.js` (dev остаётся на `/`), пути ассетов в коде —
через `src/asset.js`. Nginx-сниппет — `nginx-snippet-snowfall.conf`:
положить в `/etc/nginx/snippets/snowfall.conf`, содержимое `dist/` —
в `/var/www/games/snowfall`, в server-блок сайта добавить
`include snippets/snowfall.conf;`.

Обновление версии:

```bash
npm run build
tar -C dist -cf /tmp/snowfall-dist.tar .
scp /tmp/snowfall-dist.tar user@host:/tmp/
ssh user@host "tar -C /var/www/games/snowfall -xf /tmp/snowfall-dist.tar \
   && chown -R www-data:www-data /var/www/games/snowfall && rm /tmp/snowfall-dist.tar"
```

Реквизиты своего сервера — в `deploy/LOCAL.md` (в git не попадает).

## Вариант с нуля: отдельный сервер (Ubuntu/Debian + nginx)

```bash
# локально: собрать
npm ci
npm run build            # -> dist/

# залить на сервер (заменить user/host)
rsync -avz --delete dist/ user@host:/var/www/snowfall/

# на сервере: nginx
sudo cp nginx.conf /etc/nginx/sites-available/snowfall   # поправить server_name/root
sudo ln -s /etc/nginx/sites-available/snowfall /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

HTTPS (нужен домен): `sudo certbot --nginx -d snowfall.example.com`.
Pointer lock и WebAudio работают и по http на «голом» IP, но с https надёжнее.

## Обновление версии

```bash
npm run build && rsync -avz --delete dist/ user@host:/var/www/snowfall/
```

Бандлы Vite хэшированы — старый кэш игроков не помешает. Модели/текстуры
кэшируются на неделю: если менялись они, игроки получат обновление в течение
недели (или сразу по Ctrl+F5).

## Как пережимались ассеты

Оригиналы (Sketchfab/Poly Haven) лежат в истории git до v0.14.0. Пайплайн:

```bash
# текстуры -> WebP (базовый цвет q82, нормали q90, остальное q85), геометрия -> Draco
npx gltf-transform webp  in.gltf s1.gltf --slots "baseColor*" --quality 82
npx gltf-transform webp s1.gltf s2.gltf --slots "*normal*"   --quality 90
npx gltf-transform webp s2.gltf s3.gltf --slots "{metallicRoughness,specular,occlusion,emissive}*" --quality 85
npx gltf-transform draco s3.gltf out/scene.gltf
```

Для пака сосен перед этим из JSON удалены билборды (LOD3) и служебные узлы
(их текстуры отсутствуют на диске) + `gltf-transform prune`.
Draco-декодер для рантайма — `public/draco/` (скопирован из
`node_modules/three/examples/jsm/libs/draco/gltf/`).
