// URL ассета с учётом базового пути сборки: в dev это '/', в прод-сборке —
// '/snowfall/' (игра живёт в подкаталоге antonov-ai.ru, см. vite.config.js).
export const asset = (p) => import.meta.env.BASE_URL + p.replace(/^\//, '');
