import { defineConfig } from 'vite';

// es2022 — из-за top-level await в main.js (загрузка моделей до старта цикла).
// Проекту и так нужен современный браузер (WebGL2, pointer lock).
// base: прод-сборка живёт на https://antonov-ai.ru/snowfall/, dev — на корне
// (пути ассетов в коде идут через src/asset.js -> import.meta.env.BASE_URL).
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/snowfall/' : '/',
  build: { target: 'es2022' },
}));
