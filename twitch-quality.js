/*
 * Clip Live: na Twitch, pede a melhor qualidade ("Fonte") antes de o player carregar.
 * Grava sempre, em toda carga de página: a Twitch troca para uma qualidade baixa sozinha
 * (ou guarda a última escolhida) e os clipes saíam em baixa resolução.
 * Roda em document_start (o player lê o localStorage quando sobe).
 */
(() => {
  'use strict';
  try {
    localStorage.setItem('video-quality', JSON.stringify({ default: 'chunked' }));
  } catch (e) {
    /* sem localStorage: segue com a qualidade automática */
  }
})();
