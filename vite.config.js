import { defineConfig } from 'vite';

// es2022 — из-за top-level await в main.js (загрузка моделей до старта цикла).
// Проекту и так нужен современный браузер (WebGL2, pointer lock).
export default defineConfig({
  build: { target: 'es2022' },
});
