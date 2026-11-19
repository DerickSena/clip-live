/*
 * Clip Live: na Twitch, pede a melhor qualidade ("Fonte") antes de o player carregar.
 * Só grava a preferência se ela ainda não existe, para não brigar com a escolha do usuário.
 * Roda em document_start (o player lê o localStorage quando sobe).
 */
(() => {
  'use strict';
  try {
    if (localStorage.getItem('video-quality') === null) {
      localStorage.setItem('video-quality', JSON.stringify({ default: 'chunked' }));
      console.log('[clip-live] qualidade da Twitch: Fonte (chunked)');
    }
  } catch (e) {
    /* sem localStorage: segue com a qualidade automática */
  }
})();
