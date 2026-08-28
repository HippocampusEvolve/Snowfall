// Этот файл намеренно лежит в public, а не в src: Vite не объединяет его с
// main.js. Если основной bundle не загрузится или не разберётся, watchdog уже
// работает и не оставит человека перед бесконечной полосой.
const loading = document.getElementById('loading');
let ready = false;

function fail(reason) {
  if (ready || !loading) return;
  ready = true;
  console.error('мир не собрался:', reason);
  loading.classList.add('failed');
  loading.removeAttribute('aria-busy');
  const label = loading.querySelector('span');
  if (label) label.textContent = 'Мир не загрузился. Проверь сеть и попробуй снова';
  if (!loading.querySelector('.boot-retry')) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn boot-retry';
    retry.textContent = 'повторить';
    retry.addEventListener('click', () => location.reload());
    loading.appendChild(retry);
    retry.focus({ preventScroll: true });
  }
}

window.__FTE_BOOT__ = {
  ready() {
    ready = true;
    clearTimeout(watchdog);
  },
};

const watchdog = setTimeout(() => fail(new Error('загрузка не уложилась в 30 с')), 30000);
addEventListener('error', (event) => fail(event.error || new Error('ресурс не загрузился')), true);
addEventListener('unhandledrejection', (event) => fail(event.reason));
