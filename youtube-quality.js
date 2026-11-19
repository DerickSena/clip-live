/*
 * Clip Live: no YouTube, pede a melhor qualidade da live (até hd1080, o limite do encoder).
 * Roda no mundo da página ("world": "MAIN"), porque a API do player (#movie_player) só existe lá.
 * Só age em /watch e /live/ e só enquanto o Clip Live está gravando a aba: o content script
 * marca <html data-clip-live="gravando"> e avisa pelo evento "clip-live-qualidade".
 * Quando a gravação para (o atributo sai), solta a trava: setPlaybackQualityRange('auto', 'auto').
 * Confere a cada 30 s. Tudo em try/catch: se a API do player mudar, nada quebra.
 */
(() => {
  'use strict';
  if (window.__clipLiveYtQualidade) return;
  window.__clipLiveYtQualidade = true;

  const ORDEM = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080', 'hd1440', 'hd2160', 'hd2880', 'highres'];
  const TETO = ORDEM.indexOf('hd1080');

  let travada = false; // esta aba prendeu a qualidade (setPlaybackQualityRange)

  // A gravação parou (o atributo saiu): solta a trava e devolve o player ao automático.
  function soltar() {
    if (!travada) return;
    travada = false;
    try {
      const p = document.getElementById('movie_player');
      if (p && typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange('auto', 'auto');
      if (p && typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality('auto');
      console.log('[clip-live] qualidade do YouTube: gravação parou, de volta ao automático');
    } catch (e) {
      /* API do player diferente: nada a soltar */
    }
  }

  function ajustar() {
    try {
      if (!/^\/(watch$|live\/)/.test(location.pathname)) return;
      if (document.documentElement.getAttribute('data-clip-live') !== 'gravando') {
        soltar();
        return;
      }
      const p = document.getElementById('movie_player');
      if (!p || typeof p.getAvailableQualityLevels !== 'function' || typeof p.getPlaybackQuality !== 'function') return;
      const niveis = p.getAvailableQualityLevels() || [];
      let melhor = '';
      let mi = -1;
      for (const n of niveis) {
        const i = ORDEM.indexOf(n);
        if (i > mi && i <= TETO) {
          mi = i;
          melhor = n;
        }
      }
      if (!melhor) return;
      const atual = p.getPlaybackQuality();
      if (ORDEM.indexOf(atual) >= mi) return;
      if (typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange(melhor, melhor);
      if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality(melhor);
      travada = true;
      console.log('[clip-live] qualidade do YouTube:', atual, '->', melhor);
    } catch (e) {
      /* API do player diferente: segue na qualidade que está */
    }
  }

  setInterval(ajustar, 30_000);
  document.addEventListener('clip-live-qualidade', () => setTimeout(ajustar, 500));
  // O atributo sai quando a gravação para: solta a trava sem esperar os 30 s. Espera 3 s com o
  // atributo ausente, porque um reinício da gravação tira o atributo por um instante e a
  // qualidade não pode piscar a cada reinício.
  let soltarTimer = 0;
  new MutationObserver(() => {
    const gravando = document.documentElement.getAttribute('data-clip-live') === 'gravando';
    clearTimeout(soltarTimer);
    if (!gravando) {
      soltarTimer = setTimeout(() => {
        if (document.documentElement.getAttribute('data-clip-live') !== 'gravando') soltar();
      }, 3000);
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-clip-live'] });
  ajustar();
})();
