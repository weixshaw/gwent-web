/** Entry point. Owner: Lead. */
import { boot } from './app.js';

boot().catch((err) => {
  console.error('[gwent] boot failed', err);
  const bootEl = document.getElementById('boot-screen');
  if (bootEl) {
    bootEl.querySelector('.boot-loading').textContent = '启动失败：' + (err?.message || err);
    bootEl.querySelector('.boot-loading').style.color = '#e08a8a';
  }
});
