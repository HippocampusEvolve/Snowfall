# Сборка Android-версии (Capacitor)

Игра пакуется в APK как есть: те же файлы, что на сайте, лежат внутри
приложения и открываются в системном WebView с локального `https://localhost`.
Интернет после установки не нужен — всё офлайн.

## Требования

- Android Studio (даёт SDK и JDK 21) — `java` в PATH не нужен, Gradle зовут
  с `JAVA_HOME` от Android Studio:
  ```powershell
  $env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
  $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
  ```
- `android/local.properties` с `sdk.dir` (создаётся автоматически Android
  Studio; файл локальный, в git не идёт).

## Команды

```bash
npm run apk           # debug-APK  -> android/app/build/outputs/apk/debug/
npm run apk:release   # подписанный релиз -> .../apk/release/app-release.apk
```

Обе команды сначала собирают веб-часть отдельно: `npm run build:apk` кладёт
её в `dist-apk/` с **корневым** base (`/`), тогда как обычный `npm run build`
делает `/snowfall/` под подпапку сайта. Пути внутри APK — от корня, поэтому
сборки разные и живут в разных папках.

Версия APK берётся из `package.json`: `versionName` = версия как есть,
`versionCode` = `major*10000 + minor*100 + patch` (0.17.0 → 1700). Перед
релизом достаточно `npm version <новая>` — Gradle подхватит сам. RuStore
принимает обновление только со строго большим `versionCode`.

## Ключ подписи

**Ключ лежит вне репозитория:** `%USERPROFILE%\.android-keys\snowfall-release.jks`
(alias `snowfall`, RSA 4096, срок 10000 дней). Пароль и путь — в
`android/keystore.properties` (в `.gitignore`, как и `*.jks`).

> Потеря ключа = невозможность выпустить обновление в RuStore под тем же
> приложением. Забэкапить `.jks` **и** пароль в надёжное место.

SHA-256 сертификата: `db373c444ed60394fffcb3877672db4fc7ebd0e7c51b2500999e0dd39cc749ea`

Если `keystore.properties` нет — `assembleRelease` соберёт неподписанный APK
(чтобы репозиторий собирался на чужой машине), установить его нельзя.

Проверка подписи:

```powershell
$env:JAVA_HOME = "C:\Program Files\Android\Android Studio\jbr"
& "$env:LOCALAPPDATA\Android\Sdk\build-tools\35.0.1\apksigner.bat" verify --print-certs `
  android\app\build\outputs\apk\release\app-release.apk
```

## Что настроено в нативной части

- `ru.antonovai.snowfall`, minSdk 23, targetSdk 35.
- Ориентация `sensorLandscape` — игра от первого лица держится двумя руками.
- Полный экран: статус-бар и навигация скрыты (`MainActivity`), кадр уходит
  под вырез камеры, экран не гаснет (`FLAG_KEEP_SCREEN_ON`).
- Иконка и заставка — снежинка на ночном фоне; вектор в
  `res/drawable/ic_launcher_foreground.xml`, растр для Android < 8
  генерируется `node tools/make-icons.mjs` (он же делает `store/icon-512.png`).
- Разрешений, кроме INTERNET (нужен WebView для локального сервера), нет.

## Проверка на эмуляторе

```powershell
$sdk = "$env:LOCALAPPDATA\Android\Sdk"
& "$sdk\emulator\emulator.exe" -avd Medium_Phone_API_35 -gpu host -no-boot-anim
& "$sdk\platform-tools\adb.exe" install -r android\app\build\outputs\apk\release\app-release.apk
& "$sdk\platform-tools\adb.exe" shell am start -n ru.antonovai.snowfall/.MainActivity
```

Логи JS-консоли из WebView: `adb logcat | Select-String chromium`.

## RuStore

- Кабинет: https://console.rustore.ru — регистрация физлица бесплатна.
- Загружается **APK** (`app-release.apk`), подписанный своим ключом.
- Покупок и рекламы нет → RuStore Pay и 54-ФЗ не нужны.
- Игра не собирает персональные данные (сейв в IndexedDB на устройстве) —
  политику конфиденциальности требуют только при сборе данных.
- Скриншоты просят в 9:16; снять на эмуляторе:
  `adb exec-out screencap -p > shot.png`.
- PWA/TWA-обёртки RuStore заворачивает — поэтому и сделан нативный WebView.
