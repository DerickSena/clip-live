/*
 * Clip Live: replay buffer de lives do YouTube, da Twitch e da Kick.
 * Enquanto a live toca, codifica o vídeo do player (WebCodecs) e guarda só os
 * últimos BUFFER_SECONDS de conteúdo. Num clique, monta um MP4 com os últimos 30 s ou 60 s.
 * Com a live ativa no painel (Pérola Painel), lê o chat e salva sozinho um clipe de 60 s
 * quando muita gente ri ao mesmo tempo (corte automático).
 *
 * O YouTube exige Trusted Types: nada de innerHTML, todo DOM é montado com createElement.
 */
(() => {
  'use strict';

  // ---------- Corte automático: números (dá para baixar por autoClipDebug no storage) ----------
  const AUTO_DEFAULTS = {
    janela_s: 10, // risadas contadas nos últimos 10 s
    base_s: 300, // o "normal" é a média por janela de 10 s nos últimos 5 min...
    base_folga_s: 20, // ...sem os últimos 20 s
    minimo: 6, // dispara com risadas_10s >= max(minimo, multiplicador * base_10s + extra)
    multiplicador: 3,
    extra: 2,
    proporcao: 0.25, // e as risadas são pelo menos 25% das mensagens dos 10 s
    aquecimento_s: 120, // 2 min lendo o chat antes de poder disparar
    espera_s: 30, // dispara em T, salva em T+30 s (pega de T-30 a T+30)
    clipe_s: 60,
    pausa_s: 120, // pausa entre disparos
    max_hora: 12, // máximo de clipes automáticos por hora nesta aba
  };
  const LAUGH_RE = /k{3,}|(?:ha){2,}|(?:he){3,}|(?:hue){2,}|(?:rs){2,}|(?:ks){2,}|(?:ka){2,}|\blmao\b|\blul\b|\bkekw\b|\bomegalul\b|\bicant\b|😂|🤣|💀|!clip\b/u;
  const HEARTBEAT_MS = 10_000;
  const CHAT_FLUSH_MS = 300;
  const ID_RE = /^(yt:[A-Za-z0-9_-]{6,20}|tw:[a-z0-9_]{2,25}|kick:[a-z0-9_-]{2,40})$/;

  const BUFFER_SECONDS = 70;
  const KEYFRAME_INTERVAL_US = 1_000_000;
  const MIN_FRAME_GAP_US = 1000; // frame com timestamp repetido (ou quase) é descartado
  const GAP_US = 500_000; // mesmo valor do mux.js: intervalo maior é "buraco"
  const MAX_VIDEO_QUEUE = 8;
  const MAX_AUDIO_QUEUE = 500; // alto de propósito: o AAC do Windows segura muitos itens na fila
  const MAX_SIDE = 1920;
  const ASPECT_TOLERANCE = 0.05;
  const UPSCALE_RATIO = 1.2; // fonte mais de 20% maior que o encoder: troca para o tamanho novo
  const UPSCALE_MIN_MS = 10_000; // no máximo 1 troca de tamanho a cada 10 s
  const CHECK_MS = 2000;
  const DIAG_MS = 10_000;
  const RESTART_DELAY_MS = 1000;
  const TIMING_WAIT_MS = 3000;
  const TOAST_MS = 3000;
  const REVOKE_MS = 5 * 60_000;
  const TAG = '[clip-live]';

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  let session = null;
  let kept = null; // buffer guardado durante um reinício na mesma página
  let checkInterval = null;
  let dead = false;
  let enabled = true; // liga/desliga do popup (chrome.storage.local "enabled")
  let restartTimer = null;
  let restartTimes = [];
  let clipping = false;
  let fatalError = '';
  let seekState = { video: null, end: 0 };

  // ---------- Suporte do navegador ----------

  function checkSupport() {
    const missing = [];
    if (typeof Mediabunny === 'undefined') missing.push('Mediabunny');
    if (typeof ClipLiveMux === 'undefined') missing.push('ClipLiveMux');
    if (typeof MediaStreamTrackProcessor === 'undefined') missing.push('MediaStreamTrackProcessor');
    if (typeof VideoEncoder === 'undefined') missing.push('VideoEncoder');
    if (typeof AudioEncoder === 'undefined') missing.push('AudioEncoder');
    if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
    if (!HTMLMediaElement.prototype.captureStream) missing.push('captureStream');
    if (missing.length) {
      fatalError = 'Navegador sem suporte: ' + missing.join(', ');
      console.error(TAG, fatalError);
      return false;
    }
    return true;
  }

  // ---------- Sites (YouTube, Twitch, Kick) ----------
  // Cada site diz como achar o player, o vídeo, o selo de ao vivo, o nome do canal e o chat.
  // pageKey() devolve o id da live (contrato: yt:ID, tw:login, kick:slug) ou '' fora de uma live.

  const visible = (el) => !!el && el.isConnected && getComputedStyle(el).display !== 'none'
    && getComputedStyle(el).visibility !== 'hidden';
  const textOf = (el) => (el && (el.textContent || el.getAttribute('content') || '').trim()) || '';
  const firstText = (sels) => {
    for (const sel of sels) {
      const txt = textOf(document.querySelector(sel));
      if (txt) return txt;
    }
    return '';
  };
  const validId = (id) => (ID_RE.test(id) ? id : '');

  // Primeiro segmento do caminho, se o caminho for só "/<nome>" (ou "/<nome>/").
  function soleSegment() {
    const m = location.pathname.match(/^\/([^/]+)\/?$/);
    return m ? decodeURIComponent(m[1]).toLowerCase() : '';
  }

  const YOUTUBE = {
    name: 'youtube',
    label: 'YouTube',
    pageKey() {
      const p = location.pathname;
      let id = '';
      if (p === '/watch') id = new URLSearchParams(location.search).get('v') || '';
      else if (p.startsWith('/live/')) id = p.slice(6).split('/')[0];
      return id ? validId('yt:' + id) : '';
    },
    liveUrl: (key) => 'https://www.youtube.com/watch?v=' + key.slice(3),
    getPlayer: () => document.querySelector('#movie_player'),
    getVideo: () => document.querySelector('#movie_player video.html5-main-video')
      || document.querySelector('video.html5-main-video'),
    isLive(player, video) {
      if (!player) return false;
      const badge = player.querySelector('.ytp-live-badge');
      if (badge && getComputedStyle(badge).display !== 'none') return true;
      if (player.classList.contains('ytp-live')) return true;
      // Reforço: a meta sozinha fica velha na SPA e existe em premiere.
      if (!badge) return false;
      if (!document.querySelector('meta[itemprop="isLiveBroadcast"]')) return false;
      if (document.querySelector('meta[itemprop="endDate"]')) return false;
      if (video && video.duration === Infinity) return true;
      return seekableGrowing(video);
    },
    isAd: (player) => !!player && player.classList.contains('ad-showing'),
    channelName: () => firstText([
      '#owner ytd-channel-name a',
      'ytd-video-owner-renderer #channel-name a',
      '[itemprop="author"] link[itemprop="name"]',
    ]),
    title: () => firstText(['ytd-watch-metadata h1', 'h1.ytd-watch-metadata', 'meta[name="title"]'])
      || document.title.replace(/ - YouTube$/, ''),
    controlsSlot: (player) => player.querySelector('.ytp-right-controls'),
    detectExtra(player) {
      const badge = player && player.querySelector('.ytp-live-badge');
      return {
        badge: badge ? getComputedStyle(badge).display : 'ausente',
        extra: `ytp-live ${player && player.classList.contains('ytp-live') ? 'sim' : 'não'}`
          + ` · meta live ${document.querySelector('meta[itemprop="isLiveBroadcast"]') ? 'sim' : 'não'}`
          + (document.querySelector('meta[itemprop="endDate"]') ? ' (encerrada)' : ''),
      };
    },
    // Chat no iframe #chatframe (mesma origem): lê o contentDocument direto.
    chatRoot() {
      const f = document.querySelector('#chatframe');
      let doc = null;
      try { doc = f && f.contentDocument; } catch (e) { doc = null; }
      return doc ? doc.querySelector('yt-live-chat-item-list-renderer #items') : null;
    },
    msgSel: 'yt-live-chat-text-message-renderer',
    msgKey: (el) => el.id || '',
    msgText: (el) => collectText(el.querySelector('#message')),
    msgAuthor: (el) => textOf(el.querySelector('#author-name')),
    chatPaused: () => false,
  };

  // Caminhos da Twitch que não são canal.
  const TWITCH_RESERVED = new Set(['directory', 'videos', 'settings', 'search', 'p', 'u', 'popout',
    'downloads', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'prime', 'friends',
    'messages', 'moderator', 'following', 'login', 'signup', 'jobs', 'store', 'broadcast']);

  const TWITCH = {
    name: 'twitch',
    label: 'Twitch',
    pageKey() {
      const seg = soleSegment();
      if (!seg || TWITCH_RESERVED.has(seg)) return '';
      return validId('tw:' + seg);
    },
    liveUrl: (key) => 'https://www.twitch.tv/' + key.slice(3),
    getPlayer: () => document.querySelector('[data-a-target="video-player"]')
      || document.querySelector('.video-player'),
    getVideo: () => document.querySelector('[data-a-target="video-player"] video')
      || document.querySelector('.video-player video'),
    liveBadge: () => document.querySelector('.tw-channel-status-text-indicator')
      || document.querySelector('[data-a-target="player-overlay-live-indicator"]'),
    isLive(player, video) {
      if (!player || !video) return false;
      if (visible(TWITCH.liveBadge())) return true;
      // Reforço: mídia ao vivo tem duração infinita ou o fim do seekable crescendo.
      return video.duration === Infinity || seekableGrowing(video);
    },
    isAd: (player) => !!player && !!player.querySelector('[data-a-target="video-ad-label"], [data-a-target="video-ad-countdown"]'),
    channelName: () => firstText(['.channel-info-content h1', 'h1.tw-title', '[data-a-target="channel-header-display-name"]'])
      || soleSegment(),
    title: () => firstText(['[data-a-target="stream-title"]']) || document.title.replace(/ - Twitch$/, ''),
    controlsSlot: () => null,
    detectExtra() {
      const b = TWITCH.liveBadge();
      return { badge: b ? (visible(b) ? 'visível' : 'oculto') : 'ausente', extra: '' };
    },
    chatRoot: () => document.querySelector('[data-test-selector="chat-scrollable-area__message-container"]')
      || document.querySelector('.chat-scrollable-area__message-container'),
    msgSel: '.chat-line__message',
    msgKey: () => '',
    msgText: (el) => collectText(el.querySelector('[data-a-target="chat-line-message-body"]')),
    msgAuthor: (el) => el.getAttribute('data-a-user')
      || textOf(el.querySelector('[data-a-target="chat-message-username"]')),
    // Aviso "Chat pausado" (o usuário rolou o chat para cima): as mensagens chegam atrasadas.
    chatPaused: () => visible(document.querySelector('.chat-paused-footer, [data-a-target="chat-paused-footer"]')),
  };

  // Caminhos da Kick que não são canal.
  const KICK_RESERVED = new Set(['browse', 'categories', 'category', 'following', 'search', 'video',
    'videos', 'clips', 'settings', 'dashboard', 'events', 'subscriptions', 'login', 'signup',
    'terms-of-service', 'privacy-policy', 'community-guidelines', 'dmca-policy', 'popout', 'help']);

  const KICK = {
    name: 'kick',
    label: 'Kick',
    pageKey() {
      const seg = soleSegment();
      if (!seg || KICK_RESERVED.has(seg)) return '';
      return validId('kick:' + seg);
    },
    liveUrl: (key) => 'https://kick.com/' + key.slice(5),
    getVideo: () => document.querySelector('video#video-player'),
    getPlayer: () => {
      const v = KICK.getVideo();
      return v ? v.parentElement : null;
    },
    // Selo "AO VIVO"/"LIVE" no avatar do cabeçalho do canal.
    liveBadge() {
      const avatar = document.querySelector('[data-testid="channel-avatar"]');
      const box = avatar && (avatar.closest('button') || avatar.parentElement);
      if (!box) return null;
      for (const el of box.querySelectorAll('span, div')) {
        if (!el.childElementCount && /^(ao vivo|live)$/i.test(el.textContent.trim())) return el;
      }
      return null;
    },
    isLive(player, video) {
      if (!player || !video) return false;
      if (visible(KICK.liveBadge())) return true;
      return video.duration === Infinity || seekableGrowing(video);
    },
    isAd: () => false,
    channelName: () => firstText(['[data-testid="channel-username"]']) || soleSegment(),
    title: () => firstText(['[data-testid="livestream-title"]']) || document.title,
    controlsSlot: () => null,
    detectExtra() {
      const b = KICK.liveBadge();
      return { badge: b ? (visible(b) ? 'visível' : 'oculto') : 'ausente', extra: '' };
    },
    chatRoot: () => document.querySelector('#chatroom-messages'),
    msgSel: '[data-index]',
    // A lista é virtual (o índice pode ser reaproveitado e zera na reconexão): a chave junta
    // índice, autor e texto, e a deduplicação usa um conjunto com limite.
    msgKey: (el, text, author) => `${el.getAttribute('data-index') || ''}|${author}|${text}`,
    msgAuthor: (el) => {
      const b = el.querySelector('button[title]');
      return b ? b.getAttribute('title') || '' : '';
    },
    chatPaused: () => false,
    // A mensagem vem depois do ":" que separa o nome de usuário.
    msgText(el) {
      const sep = [...el.querySelectorAll('span[aria-hidden="true"]')].find((s) => s.textContent.trim().startsWith(':'));
      return sep ? collectText(el, sep) : '';
    },
  };

  const SITE = location.hostname === 'kick.com' ? KICK
    : location.hostname === 'www.twitch.tv' ? TWITCH
      : YOUTUBE;

  const getPlayer = () => SITE.getPlayer();
  const getVideo = () => SITE.getVideo();
  const pageKey = () => SITE.pageKey();

  // Texto de um nó (com o alt das imagens, que é onde ficam emoji e emotes).
  // Com "after", só conta o que vem depois desse elemento (nome de usuário fica de fora).
  function collectText(root, after) {
    if (!root) return '';
    let out = '';
    const walker = root.ownerDocument.createTreeWalker(root, 1 | 4); // elementos e textos
    let n;
    while ((n = walker.nextNode())) {
      if (after && (after === n || after.contains(n)
        || !(after.compareDocumentPosition(n) & 4))) continue; // 4 = DOCUMENT_POSITION_FOLLOWING
      if (n.nodeType === 3) out += n.data;
      else if (n.tagName === 'IMG') out += ' ' + (n.getAttribute('alt') || '') + ' ';
    }
    return out.trim();
  }

  // O fim do seekable cresce entre duas checagens = mídia ao vivo.
  function seekableGrowing(video) {
    if (!video || !(video.duration > 0)) return false;
    const r = video.seekable;
    const end = r && r.length ? r.end(r.length - 1) : 0;
    const growing = seekState.video === video && end > seekState.end;
    seekState = { video, end };
    return growing;
  }

  const isLive = (player, video) => SITE.isLive(player, video);
  const isAd = (player) => SITE.isAd(player);

  // Pausado, buscando ou sem dados à frente (HAVE_FUTURE_DATA): o que chega é frame congelado.
  const isStalled = (video) => video.paused || video.seeking || video.readyState < 3;

  function check() {
    try {
      if (dead) return;
      if (!runtimeAlive()) {
        teardown();
        return;
      }
      const key = pageKey();
      const live = fatalError ? false : checkRecording(key);
      autoTick(key, live);
    } catch (e) {
      warn('erro na checagem', e);
    }
  }

  // Liga, mantém ou para a gravação. Devolve true se a aba está numa live gravando.
  function checkRecording(key) {
    // Desligada pelo popup: não grava nada e não mostra botões (economiza processador).
    if (!enabled) {
      if (session || kept) log('desligada pelo usuário, parando');
      stopSession();
      kept = null;
      removeControls();
      return false;
    }
    const player = getPlayer();
    const video = getVideo();
    const s = session;
    // Durante anúncio no meio da live o selo some: mantém a sessão (ou o buffer guardado) da mesma página.
    const cur = s || kept;
    const live = key && (isLive(player, video) || (cur && cur.key === key && isAd(player)));

    if (!live || !video) {
      if (s || kept) log('saiu da live, parando');
      stopSession();
      kept = null;
      removeControls();
      return false;
    }
    if (kept && kept.key !== key) kept = null;
    if (s && s.key !== key) {
      log('página mudou, reiniciando');
      stopSession();
    } else if (s && s.video !== video) {
      // Mesmo endereço, <video> novo: reinicia o pipeline mas guarda o buffer.
      log('<video> mudou, reiniciando sem perder o buffer');
      keepAndStop(s);
    }
    if (!session && !restartTimer) startSession(key, video, player);
    if (session) {
      ensureControls(player);
      diagnose(session);
    }
    return true;
  }

  // Extensão recarregada: este script antigo fica sem chrome.runtime válido.
  function runtimeAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function teardown() {
    dead = true;
    log('extensão recarregada ou desligada: parando este script');
    stopSession();
    kept = null;
    clearInterval(checkInterval);
    clearTimeout(restartTimer);
    clearTimeout(auto.pendingTimer);
    auto.pending = null;
    chatStop();
    document.removeEventListener('yt-navigate-finish', onNavigate);
    try { chrome.storage.onChanged.removeListener(onStorageChange); } catch (e) { /* runtime já morto */ }
    removeControls();
    if (toastEl) toastEl.remove();
  }

  // A cada 10 s, mostra no console os contadores da sessão.
  function diagnose(s) {
    const now = performance.now();
    if (now - s.lastDiag < DIAG_MS) return;
    s.lastDiag = now;
    const st = statusOf(s);
    const keys = ['seconds', 'framesIn', 'framesAd', 'framesPaused', 'framesDropped', 'chunksVideo',
      'audioIn', 'audioInSec', 'audioDropDup', 'audioDropQueue', 'audioDropAd', 'audioDropPaused',
      'audioChunksOut', 'audioOutSec', 'audioLagMs', 'adShowing', 'hidden'];
    log('diag ' + keys.map((k) => `${k}=${st[k]}`).join(' ') + (s.error ? ' erro=' + s.error : ''));
  }

  function scheduleRestart(reason) {
    if (restartTimer) return;
    log('reiniciando pipeline:', reason);
    if (session) keepAndStop(session);
    const now = Date.now();
    restartTimes = restartTimes.filter((t) => now - t < 30_000);
    restartTimes.push(now);
    // Se reinicia demais, espera mais para não ficar em loop.
    const delay = restartTimes.length > 5 ? 10_000 : RESTART_DELAY_MS;
    restartTimer = setTimeout(() => {
      restartTimer = null;
      check();
    }, delay);
  }

  // ---------- Sessão (pipeline) ----------

  function startSession(key, video, player) {
    let stream;
    try {
      stream = video.captureStream();
    } catch (e) {
      warn('captureStream falhou', e);
      return;
    }
    const s = {
      key, video, player, stream,
      stopped: false,
      error: '',
      readers: [],
      trackIds: new Set(),
      // diagnóstico
      framesIn: 0,
      framesAd: 0,
      framesDropped: 0,
      framesPaused: 0,
      audioIn: 0,
      audioInSec: 0,
      audioDropDup: 0,
      audioDropQueue: 0,
      audioDropAd: 0,
      audioDropPaused: 0,
      audioChunksOut: 0,
      audioOutSec: 0,
      lastAudioInTs: 0,
      lastAudioOutTs: 0,
      lastDiag: performance.now(),
      // vídeo
      venc: null,
      vConfiguring: false,
      srcAspect: 0,
      encW: 0, encH: 0,
      lastResize: 0,
      canvas: null, ctx: null,
      epoch: 0,
      epochHasKey: new Set(),
      epochConfigs: new Map(),
      lastVideoTs: -Infinity,
      lastKeyTs: -Infinity,
      needKey: true,
      videoChunks: [],
      // áudio
      aenc: null,
      aConfiguring: false,
      aKey: '',
      aCodec: null,
      aDecoderConfig: null,
      aRate: 0,
      aTimeline: null,
      lastAudioTs: -Infinity,
      audioChunks: [],
      // relógios
      timing: { firsts: new Map(), startedAt: 0, decided: false, rebase: false, anchor: 0, offsets: { video: 0, audio: 0 } },
      expectedTracks: 0,
      // Relógio do buffer: timestamp guardado menos a chegada (us), para continuar depois de um reinício.
      anchor: null,
      mergeFrom: 0,
    };
    if (kept && kept.key === key) {
      const k = kept;
      Object.assign(s, {
        videoChunks: k.videoChunks,
        audioChunks: k.audioChunks,
        epochConfigs: k.epochConfigs,
        epochHasKey: k.epochHasKey,
        epoch: k.epoch,
        encW: k.encW,
        encH: k.encH,
        srcAspect: k.srcAspect,
        aDecoderConfig: k.aDecoderConfig,
        aCodec: k.aCodec,
        anchor: k.anchor,
        // O encoder novo pode continuar a mesma época se o decoderConfig sair igual.
        mergeFrom: k.epoch,
      });
      // Tracks novas podem ter outra base de tempo: tudo vai para o relógio do buffer antigo.
      s.timing = {
        firsts: new Map(), startedAt: performance.now(), decided: true, rebase: true,
        anchor: k.anchor, offsets: { video: 0, audio: 0 },
      };
      log(`continuando o buffer da sessão anterior (${k.videoChunks.length} chunks de vídeo, época ${k.epoch})`);
    }
    kept = null;
    session = s;

    const tracks = stream.getTracks();
    s.expectedTracks = tracks.length;
    log('captura iniciada:', tracks.map((t) => t.kind).join(', ') || 'sem tracks ainda');
    tracks.forEach((t) => attachTrack(s, t));
    stream.addEventListener('addtrack', (ev) => {
      if (s.stopped) return;
      s.expectedTracks = Math.max(s.expectedTracks, stream.getTracks().length);
      attachTrack(s, ev.track);
    });
    stream.addEventListener('removetrack', () => {
      if (!s.stopped) scheduleRestart('track removida');
    });
  }

  // Para encoders, leitores e tracks (não mexe no buffer).
  function stopPipeline(s) {
    s.stopped = true;
    for (const r of s.readers) r.cancel().catch(() => {});
    try { s.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* nada */ }
    closeCoder(s.venc);
    closeCoder(s.aenc);
    s.venc = null;
    s.aenc = null;
    s.canvas = null;
    s.ctx = null;
  }

  // Reinício na mesma página: para o pipeline e guarda o buffer para a próxima sessão.
  function keepAndStop(s) {
    stopPipeline(s);
    if (session === s) session = null;
    kept = s.videoChunks.length && s.anchor !== null ? s : null;
    if (kept) log(`buffer guardado para o reinício (${s.videoChunks.length} chunks de vídeo)`);
  }

  // Para tudo e descarta o buffer (mudou de página ou saiu da live).
  function stopSession() {
    const s = session;
    session = null;
    if (!s) return;
    stopPipeline(s);
    s.videoChunks.length = 0;
    s.audioChunks.length = 0;
    s.epochConfigs.clear();
    s.epochHasKey.clear();
  }

  function closeCoder(c) {
    try { if (c && c.state !== 'closed') c.close(); } catch (e) { /* nada */ }
  }

  // Um leitor por track (o addtrack pode repetir uma track que já existe).
  function attachTrack(s, track) {
    if (s.trackIds.has(track.id)) return;
    if (track.kind !== 'video' && track.kind !== 'audio') return;
    s.trackIds.add(track.id);
    track.addEventListener('ended', () => {
      if (!s.stopped) scheduleRestart(`track ${track.kind} terminou`);
    });
    pump(s, track);
  }

  async function pump(s, track) {
    const kind = track.kind;
    let reader;
    try {
      const proc = new MediaStreamTrackProcessor({ track });
      reader = proc.readable.getReader();
      s.readers.push(reader);
      while (!s.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        if (kind === 'video') onVideoFrame(s, value);
        else onAudioData(s, value);
      }
    } catch (e) {
      if (!s.stopped) warn(`leitor de ${kind} falhou`, e);
    }
    if (!s.stopped) scheduleRestart(`leitor de ${kind} acabou`);
  }

  // ---------- Relógios de vídeo e áudio ----------

  // Registra o primeiro timestamp de cada track e decide se precisa rebasear.
  // Retorna false enquanto ainda não dá para decidir (a amostra é descartada).
  function timingReady(s, kind, ts) {
    const t = s.timing;
    if (!t.firsts.has(kind)) {
      const arrival = performance.now() * 1000;
      t.firsts.set(kind, { raw: ts, arrival });
      if (!t.startedAt) t.startedAt = performance.now();
      log(`primeiro ${kind}: timestamp=${ts}us performance.now=${(arrival / 1000).toFixed(1)}ms`);
      if (t.decided) lateTrack(t, kind, ts, arrival);
    }
    if (t.decided) return true;
    const all = t.firsts.size >= Math.max(1, s.expectedTracks);
    if (!all && performance.now() - t.startedAt < TIMING_WAIT_MS) return false;

    t.decided = true;
    const v = t.firsts.get('video');
    const a = t.firsts.get('audio');
    if (v && a) {
      const diff = (v.raw - v.arrival) - (a.raw - a.arrival);
      log(`diferença entre as bases de tempo: ${(diff / 1000).toFixed(1)}ms`);
      if (Math.abs(diff) > 1e6) {
        t.rebase = true;
        t.anchor = 0;
        t.offsets.video = v.arrival - v.raw;
        t.offsets.audio = a.arrival - a.raw;
        log('bases diferentes: rebaseando pelo relógio de chegada');
      }
    }
    return true;
  }

  // Track que chegou depois da decisão: alinha só ela ao relógio que já está valendo.
  function lateTrack(t, kind, ts, arrival) {
    if (t.rebase) {
      t.offsets[kind] = arrival + t.anchor - ts;
      return;
    }
    const other = kind === 'video' ? 'audio' : 'video';
    const o = t.firsts.get(other);
    if (!o) return;
    const anchor = o.raw + t.offsets[other] - o.arrival;
    const diff = ts - arrival - anchor;
    log(`${kind} chegou depois: diferença para a outra base ${(diff / 1000).toFixed(1)}ms`);
    if (Math.abs(diff) > 1e6) {
      t.offsets[kind] = arrival + anchor - ts;
      log(`rebaseando só o ${kind}`);
    }
  }

  // ---------- Vídeo ----------

  function onVideoFrame(s, frame) {
    let scaled = null;
    try {
      if (s.stopped) return;
      s.framesIn++;
      if (isAd(s.player)) {
        s.framesAd++;
        return;
      }
      // Pausado o captureStream continua mandando o frame congelado: descarta para virar buraco.
      if (isStalled(s.video)) {
        s.framesPaused++;
        return;
      }
      if (s.error) return;
      if (!timingReady(s, 'video', frame.timestamp)) return;
      // Timestamp repetido ou para trás: descarta (o MP4 exige tempo crescente).
      if (frame.timestamp < s.lastVideoTs + MIN_FRAME_GAP_US) {
        s.framesDropped++;
        return;
      }
      const w = frame.displayWidth;
      const h = frame.displayHeight;
      // Tamanho fixo por sessão; muda de época se a proporção mudar ou se a fonte crescer
      // (Twitch e Kick começam em qualidade baixa e sobem depois).
      if (!s.venc || aspectChanged(s, w, h)) {
        if (!s.vConfiguring) configureVideo(s, w, h);
        return;
      }
      if (sourceGrew(s, w, h)) {
        if (!s.vConfiguring) configureVideo(s, w, h, true);
        return;
      }
      const enc = s.venc;
      if (enc.state !== 'configured' || enc.encodeQueueSize > MAX_VIDEO_QUEUE) {
        s.framesDropped++;
        return;
      }
      s.lastVideoTs = frame.timestamp;
      s.anchor = frame.timestamp + s.timing.offsets.video - performance.now() * 1000;
      // Keyframe a cada 1 s (e logo depois de qualquer buraco maior que isso).
      const keyFrame = s.needKey || frame.timestamp - s.lastKeyTs >= KEYFRAME_INTERVAL_US;
      if (keyFrame) {
        s.needKey = false;
        s.lastKeyTs = frame.timestamp;
      }
      if (w !== s.encW || h !== s.encH) {
        scaled = scaleFrame(s, frame);
        enc.encode(scaled, { keyFrame });
      } else {
        enc.encode(frame, { keyFrame });
      }
    } catch (e) {
      warn('erro ao codificar vídeo', e);
    } finally {
      if (scaled) scaled.close();
      frame.close();
    }
  }

  // A fonte cresceu bem acima do tamanho do encoder (só para cima, no máximo 1 vez a cada 10 s).
  function sourceGrew(s, w, h) {
    if (!s.encW || performance.now() - s.lastResize < UPSCALE_MIN_MS) return false;
    // Corte automático pendente: a troca de época encurtaria o clipe. Espera ele sair.
    if (auto.pending) return false;
    const f = fitSize(w, h);
    return f.w > s.encW * UPSCALE_RATIO || f.h > s.encH * UPSCALE_RATIO;
  }

  function aspectChanged(s, w, h) {
    const a = w / h;
    return Math.abs(a - s.srcAspect) / s.srcAspect > ASPECT_TOLERANCE;
  }

  // Redimensiona para o tamanho do encoder (anúncio, troca de qualidade, frame maior que 1920).
  function scaleFrame(s, frame) {
    if (!s.canvas || s.canvas.width !== s.encW || s.canvas.height !== s.encH) {
      s.canvas = new OffscreenCanvas(s.encW, s.encH);
      s.ctx = s.canvas.getContext('2d', { alpha: false });
    }
    s.ctx.drawImage(frame, 0, 0, s.encW, s.encH);
    const init = { timestamp: frame.timestamp };
    if (frame.duration) init.duration = frame.duration;
    return new VideoFrame(s.canvas, init);
  }

  function fitSize(w, h) {
    const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
    const even = (n) => Math.max(2, Math.round(n / 2) * 2);
    return { w: even(w * scale), h: even(h * scale) };
  }

  async function pickVideoConfig(w, h) {
    const bitrate = h >= 1080 ? 8_000_000 : h >= 720 ? 5_000_000 : 2_500_000;
    for (const codec of ['avc1.64002A', 'avc1.640033']) {
      for (const hw of ['prefer-hardware', 'no-preference']) {
        const cfg = {
          codec, width: w, height: h, bitrate, framerate: 60,
          latencyMode: 'realtime', hardwareAcceleration: hw, avc: { format: 'avc' },
        };
        try {
          const r = await VideoEncoder.isConfigSupported(cfg);
          if (r.supported) return cfg;
        } catch (e) { /* tenta o próximo */ }
      }
    }
    return null;
  }

  // Primeiro frame de live, proporção nova ou fonte maior (upscale) = novo encoder e nova época.
  async function configureVideo(s, w, h, upscale = false) {
    s.vConfiguring = true;
    try {
      closeCoder(s.venc);
      s.venc = null;
      // Mantém o tamanho fixo se já existe (reinício) e a proporção é a mesma, menos na subida de qualidade.
      const keepSize = !!s.encW && !aspectChanged(s, w, h) && !upscale;
      if (upscale) log(`a fonte cresceu (${w}x${h}, encoder ${s.encW}x${s.encH}): trocando para o tamanho novo`);
      const size = keepSize ? { w: s.encW, h: s.encH } : fitSize(w, h);
      const cfg = await pickVideoConfig(size.w, size.h);
      if (s.stopped) return;
      if (!cfg) {
        s.error = `Este navegador não tem codificador H.264 para ${size.w}x${size.h}`;
        warn(s.error);
        return;
      }
      let epoch = s.epoch + 1;
      const mergeFrom = keepSize ? s.mergeFrom : 0;
      s.mergeFrom = 0;
      const enc = new VideoEncoder({
        output: (chunk, meta) => {
          // Primeiro chunk do encoder novo depois de um reinício: mesmo decoderConfig = mesma época.
          if (mergeFrom && epoch !== mergeFrom && meta && meta.decoderConfig
            && !s.epochHasKey.has(epoch)
            && sameConfig(meta.decoderConfig, s.epochConfigs.get(mergeFrom))) {
            log(`decoderConfig igual: continuando a época ${mergeFrom}`);
            if (s.epoch === epoch) s.epoch = mergeFrom;
            epoch = mergeFrom;
          }
          onVideoChunk(s, epoch, chunk, meta);
        },
        error: (e) => {
          warn(`erro no VideoEncoder (época ${epoch}, ${size.w}x${size.h})`, e);
          if (!s.stopped) scheduleRestart('erro no VideoEncoder');
        },
      });
      enc.configure(cfg);
      s.venc = enc;
      s.epoch = epoch;
      if (!keepSize) s.srcAspect = w / h;
      s.encW = size.w;
      s.encH = size.h;
      s.lastResize = performance.now();
      s.needKey = true;
      log(`vídeo: época ${epoch}, frame ${w}x${h}, encoder ${size.w}x${size.h}, ${cfg.codec}, ${cfg.bitrate / 1e6} Mbps, ${cfg.hardwareAcceleration}`);
    } catch (e) {
      warn('falha ao configurar vídeo', e);
      if (!s.stopped) scheduleRestart('falha ao configurar vídeo');
    } finally {
      s.vConfiguring = false;
    }
  }

  // Compara dois decoderConfig (codec, tamanho e description byte a byte).
  function sameConfig(a, b) {
    if (!a || !b) return false;
    if (a.codec !== b.codec || a.codedWidth !== b.codedWidth || a.codedHeight !== b.codedHeight) return false;
    if (a.sampleRate !== b.sampleRate || a.numberOfChannels !== b.numberOfChannels) return false;
    const bytes = (d) => {
      if (!d) return new Uint8Array(0);
      if (d instanceof ArrayBuffer) return new Uint8Array(d);
      return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    };
    const x = bytes(a.description);
    const y = bytes(b.description);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  function onVideoChunk(s, epoch, chunk, meta) {
    if (s.stopped) return;
    if (meta && meta.decoderConfig) s.epochConfigs.set(epoch, meta.decoderConfig);
    const key = chunk.type === 'key';
    // Época sem keyframe guardado ainda: espera o primeiro.
    if (!s.epochHasKey.has(epoch)) {
      if (!key) return;
      s.epochHasKey.add(epoch);
    }
    s.videoChunks.push({
      chunk,
      timestamp: chunk.timestamp + s.timing.offsets.video,
      key,
      epoch,
    });
    if (key) trimBuffer(s);
  }

  // ---------- Áudio ----------

  function onAudioData(s, data) {
    try {
      if (s.stopped || s.error) return;
      s.audioIn++;
      s.audioInSec += data.numberOfFrames / data.sampleRate;
      if (isAd(s.player)) {
        s.audioDropAd++;
        return;
      }
      if (isStalled(s.video)) {
        s.audioDropPaused++;
        return;
      }
      if (!timingReady(s, 'audio', data.timestamp)) return;
      if (data.timestamp <= s.lastAudioTs) {
        s.audioDropDup++;
        return;
      }
      const aKey = `${data.sampleRate}/${data.numberOfChannels}`;
      if (aKey !== s.aKey) {
        if (!s.aConfiguring) configureAudio(s, data.sampleRate, data.numberOfChannels);
        return;
      }
      const enc = s.aenc;
      if (!enc || enc.state !== 'configured') return;
      if (enc.encodeQueueSize > MAX_AUDIO_QUEUE) {
        s.audioDropQueue++;
        return;
      }
      s.lastAudioTs = data.timestamp;
      const ts = data.timestamp + s.timing.offsets.audio;
      s.aTimeline.push(ts, data.numberOfFrames);
      s.lastAudioInTs = ts;
      enc.encode(data);
    } catch (e) {
      warn('erro ao codificar áudio', e);
    } finally {
      data.close();
    }
  }

  async function pickAudioConfig(sampleRate, numberOfChannels) {
    const base = { sampleRate, numberOfChannels, bitrate: 160_000 };
    const candidates = [
      [{ ...base, codec: 'mp4a.40.2', aac: { format: 'aac' } }, 'aac'],
      [{ ...base, codec: 'mp4a.40.2' }, 'aac'],
      [{ ...base, codec: 'opus' }, 'opus'],
    ];
    for (const [cfg, name] of candidates) {
      try {
        const r = await AudioEncoder.isConfigSupported(cfg);
        if (r.supported) return { cfg, name };
      } catch (e) { /* tenta o próximo */ }
    }
    return null;
  }

  async function configureAudio(s, sampleRate, channels) {
    s.aConfiguring = true;
    try {
      closeCoder(s.aenc);
      s.aenc = null;
      // O áudio antigo só é descartado se o decoderConfig novo for diferente (onAudioChunk).
      s.aTimeline = null;
      const picked = await pickAudioConfig(sampleRate, channels);
      if (s.stopped) return;
      s.aKey = `${sampleRate}/${channels}`;
      if (!picked) {
        warn(`nenhum codec de áudio suportado (${s.aKey}); clipes sairão sem som`);
        return;
      }
      const enc = new AudioEncoder({
        output: (chunk, meta) => onAudioChunk(s, enc, chunk, meta),
        error: (e) => {
          warn('erro no AudioEncoder', e);
          if (!s.stopped) scheduleRestart('erro no AudioEncoder');
        },
      });
      enc.configure(picked.cfg);
      s.aenc = enc;
      s.aCodec = picked.name;
      s.aRate = sampleRate;
      s.aTimeline = ClipLiveMux.createAudioTimeline(sampleRate);
      log(`áudio: ${picked.cfg.codec} (${picked.name}), ${sampleRate} Hz, ${channels} canais`);
    } catch (e) {
      warn('falha ao configurar áudio', e);
      if (!s.stopped) scheduleRestart('falha ao configurar áudio');
    } finally {
      s.aConfiguring = false;
    }
  }

  function onAudioChunk(s, enc, chunk, meta) {
    if (s.stopped || enc !== s.aenc) return;
    if (meta && meta.decoderConfig) {
      if (s.aDecoderConfig && !sameConfig(meta.decoderConfig, s.aDecoderConfig)) {
        log('formato do áudio mudou: descartando o áudio antigo do buffer');
        s.audioChunks.length = 0;
      }
      s.aDecoderConfig = meta.decoderConfig;
    }
    // O timestamp de saída do encoder não é confiável (ver createAudioTimeline no mux.js):
    // o tempo vem da fila de entradas, contando amostras. AAC tem sempre 1024 por pacote.
    const frames = s.aCodec === 'aac'
      ? 1024
      : Math.round(((chunk.duration || 20_000) * s.aRate) / 1e6);
    const t = s.aTimeline.next(frames);
    if (!t || !s.aDecoderConfig) return;
    if (!s.audioChunksOut) log(`primeiro chunk de áudio: encoder=${chunk.timestamp}us calculado=${t.timestamp}us`);
    s.audioChunksOut++;
    s.audioOutSec += t.duration / 1e6;
    s.lastAudioOutTs = t.timestamp;
    s.audioChunks.push({ chunk, timestamp: t.timestamp, duration: t.duration });
    // Corte sempre (aba escondida com vídeo parado não pode fazer o áudio crescer).
    // Conta tempo de conteúdo (nº de pacotes x duração), e não de relógio: assim uma pausa
    // longa não apaga o áudio que ainda acompanha o vídeo de antes da pausa.
    const a = s.audioChunks;
    const max = Math.ceil(((BUFFER_SECONDS + 10) * 1e6) / t.duration);
    if (a.length > max) a.splice(0, a.length - max);
  }

  // ---------- Buffer circular ----------

  // Mantém ~BUFFER_SECONDS de conteúdo (buracos contam como um frame) a partir de um keyframe.
  function trimBuffer(s) {
    const v = s.videoChunks;
    if (v.length < 2) return;
    const limit = BUFFER_SECONDS * 1e6;
    let acc = 0;
    let idx = -1;
    for (let i = v.length - 1; i > 0; i--) {
      const d = v[i].timestamp - v[i - 1].timestamp;
      acc += d > GAP_US ? 33_333 : Math.max(0, d);
      if (acc >= limit) {
        idx = i - 1;
        break;
      }
    }
    if (idx <= 0) return;
    let cut = 0;
    for (let i = idx; i > 0; i--) {
      if (v[i].key) {
        cut = i;
        break;
      }
    }
    if (!cut) return;
    v.splice(0, cut);

    const alive = new Set(v.map((c) => c.epoch));
    alive.add(s.epoch);
    for (const ep of [...s.epochConfigs.keys()]) if (!alive.has(ep)) s.epochConfigs.delete(ep);
    for (const ep of [...s.epochHasKey]) if (!alive.has(ep)) s.epochHasKey.delete(ep);

    const a = s.audioChunks;
    const first = v[0].timestamp;
    let j = 0;
    while (j < a.length && a[j].timestamp < first) j++;
    if (j > 0) a.splice(0, j);
  }

  function currentEpochChunks(s) {
    return s.videoChunks.filter((c) => c.epoch === s.epoch);
  }

  function bufferedSeconds(s) {
    return Math.round(ClipLiveMux.contentDuration(currentEpochChunks(s)) / 1e6);
  }

  function statusOf(s) {
    return {
      recording: !!s && !s.error,
      seconds: s && !s.error ? bufferedSeconds(s) : 0,
      width: s ? s.encW : 0,
      height: s ? s.encH : 0,
      codecAudio: s ? s.aCodec : null,
      error: fatalError || (s && s.error) || null,
      framesIn: s ? s.framesIn : 0,
      framesAd: s ? s.framesAd : 0,
      framesDropped: s ? s.framesDropped : 0,
      framesPaused: s ? s.framesPaused : 0,
      audioIn: s ? s.audioIn : 0,
      audioInSec: s ? +s.audioInSec.toFixed(2) : 0,
      audioDropDup: s ? s.audioDropDup : 0,
      audioDropQueue: s ? s.audioDropQueue : 0,
      audioDropAd: s ? s.audioDropAd : 0,
      audioDropPaused: s ? s.audioDropPaused : 0,
      audioChunksOut: s ? s.audioChunksOut : 0,
      audioOutSec: s ? +s.audioOutSec.toFixed(2) : 0,
      // Último timestamp de entrada (rebaseado) menos o último de saída: atraso do encoder.
      audioLagMs: s && s.audioChunksOut ? Math.round((s.lastAudioInTs - s.lastAudioOutTs) / 1000) : 0,
      chunksVideo: s ? currentEpochChunks(s).length : 0,
      adShowing: isAd(getPlayer()),
      hidden: document.hidden,
      enabled,
      site: SITE.name,
      detect: detectInfo(),
      auto: autoStatus(pageKey()),
    };
  }

  // Diagnóstico da detecção de live, para o popup explicar por que não está gravando.
  function detectInfo() {
    const player = getPlayer();
    const video = getVideo();
    const ex = SITE.detectExtra(player);
    return {
      site: SITE.label,
      page: pageKey() || location.pathname,
      player: !!player,
      video: !!video,
      badge: ex.badge,
      extra: ex.extra,
      duration: video ? String(video.duration) : null,
      live: !!(session || kept),
    };
  }

  // ---------- Clipe ----------

  // opts.auto = corte automático (nome com _auto, .json com o motivo).
  async function clip(seconds, opts = {}) {
    seconds = seconds === 60 ? 60 : 30;
    const auto = !!opts.auto;
    if (clipping) {
      toast('Já estou montando um clipe, espere um pouco');
      return { ok: false, error: 'ocupado' };
    }
    const s = session || kept;
    if (!s) {
      toast(fatalError || 'Abra uma live do YouTube, Twitch ou Kick para clipar');
      return { ok: false, error: fatalError || 'sem live' };
    }
    if (s.error) {
      toast(s.error);
      return { ok: false, error: s.error };
    }
    const v = currentEpochChunks(s);
    const cfgV = s.epochConfigs.get(s.epoch);
    if (!v.length || !cfgV) {
      toast('Ainda não tem nada gravado');
      return { ok: false, error: 'buffer vazio' };
    }

    clipping = true;
    const clickedAt = new Date();
    toast('Montando clipe...', 0);
    try {
      // Copia as listas antes: a gravação continua enquanto o MP4 é montado.
      const aCopy = s.aDecoderConfig ? s.audioChunks.slice() : [];
      const sel = ClipLiveMux.selectClip(v, aCopy, seconds);
      if (!sel || !sel.video.length) {
        toast('Ainda não tem nada gravado');
        return { ok: false, error: 'buffer vazio' };
      }
      // Época anterior (proporção mudou) existe e não cabe no clipe.
      const epochChanged = s.videoChunks.length > 0 && s.videoChunks[0].epoch !== s.epoch;

      const buf = await ClipLiveMux.buildMp4(Mediabunny, {
        video: sel.video,
        audio: sel.audio,
        videoConfig: cfgV,
        audioConfig: s.aDecoderConfig,
        audioCodec: s.aCodec,
      });

      const dur = Math.max(1, Math.round(sel.durationUs / 1e6));
      const filename = buildFilename(clickedAt, seconds, auto);
      // O .json de origem vai antes do .mp4 (quem pega o .mp4 já acha o .json do lado).
      const meta = sourceInfo(s.key, clickedAt, auto, opts.motivo);
      const jsonName = filename.replace(/\.mp4$/, '.json');
      const howJson = await download(new TextEncoder().encode(JSON.stringify(meta, null, 2)), jsonName, 'application/json');
      log(`origem salva em ${jsonName} via ${howJson}`);
      const how = await download(buf, filename);

      let msg;
      if (dur < seconds - 1 && epochChanged) msg = `Clipe com ${dur}s salvo (o formato do vídeo mudou)`;
      else if (dur < seconds - 1) msg = `Clipe com ${dur}s salvo (só tinha isso gravado)`;
      else msg = `Clipe de ${seconds}s salvo`;
      if (!sel.audio.length) msg += ', sem som';
      if (auto) {
        msg = 'Corte automático salvo';
        if (dur < seconds - 1) msg += epochChanged ? ` (${dur}s, o formato do vídeo mudou)` : ` (${dur}s)`;
      }
      toast(msg);
      log(`clipe: ${dur}s, ${sel.video.length} frames, ${sel.audio.length} pacotes de áudio, ${sel.gaps} buraco(s) comprimido(s), ${buf.byteLength} bytes, via ${how}`);
      return { ok: true, seconds: dur, filename, file: filename.split('/').pop(), message: msg };
    } catch (e) {
      console.error(TAG, 'falha ao montar clipe', e);
      toast('Não consegui montar o clipe (veja o console)');
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      clipping = false;
    }
  }

  function channelName() {
    return SITE.channelName() || SITE.name;
  }

  // Data e hora local no formato AAAA-MM-DDTHH:MM:SS (sem fuso), como o resto do painel.
  function localIso(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // Conteúdo do .json de origem (contrato item 5).
  function sourceInfo(key, d, auto, motivo) {
    const info = {
      url: key ? SITE.liveUrl(key) : location.href,
      titulo: SITE.title() || '',
      canal: channelName(),
      plataforma: SITE.name,
      inicio: null,
      fim: null,
      baixado_em: localIso(d),
      origem: 'clip-live',
      auto,
    };
    if (auto) info.motivo = motivo || '';
    return info;
  }

  function sanitize(name) {
    const out = name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^[.\s-]+/g, '')
      .slice(0, 40)
      .replace(/[.\s-]+$/g, '');
    return out || SITE.name;
  }

  function buildFilename(d, seconds, auto) {
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
    return `clip-live/${sanitize(channelName())}_${date}_${time}_${seconds}s${auto ? '_auto' : ''}.mp4`;
  }

  // Tenta pelo service worker (subpasta clip-live/); se falhar, cai para <a download>.
  async function download(buf, filename, type = 'video/mp4') {
    const url = URL.createObjectURL(new Blob([buf], { type }));
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'download', url, filename });
      if (res && res.ok) {
        log('download pelo service worker funcionou');
        return 'service worker';
      }
      warn('download pelo service worker falhou:', res && res.error);
    } catch (e) {
      warn('download pelo service worker falhou:', e);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename.split('/').pop();
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    log('download pelo <a download> (vai direto para Downloads, sem subpasta)');
    return '<a download>';
  }

  // ---------- Interface no player ----------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const SCISSORS_PATH = 'M9.64 7.64A4 4 0 1 0 6 10c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36A3.9 3.9 0 0 0 6 14a4 4 0 1 0 3.64 2.36L12 14l7 7h3v-1L9.64 7.64zM6 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 12a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6-7.5a.5.5 0 1 1 0-1 .5.5 0 0 1 0 1zM19 3l-6 6 2 2 7-7V3h-3z';

  function scissorsIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('d', SCISSORS_PATH);
    svg.appendChild(path);
    return svg;
  }

  let controls = null;

  function buildControls() {
    const box = document.createElement('div');
    box.className = 'clip-live-controls';
    const dot = document.createElement('span');
    dot.className = 'clip-live-dot';
    box.appendChild(dot);
    // Selo "AUTO": a live desta aba está ativa no corte automático do painel.
    const badge = document.createElement('span');
    badge.className = 'clip-live-auto';
    badge.textContent = 'AUTO';
    badge.hidden = true;
    box.appendChild(badge);
    for (const [sec, label] of [[30, '30s'], [60, '1min']]) {
      const b = document.createElement('button');
      b.className = 'clip-live-btn';
      b.type = 'button';
      const text = document.createElement('span');
      text.textContent = label;
      b.append(scissorsIcon(), text);
      b.setAttribute('aria-label', `Clipar os últimos ${label}`);
      b.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        b.blur();
        clip(sec);
      });
      box.appendChild(b);
    }
    return box;
  }

  function ensureControls(player) {
    if (!player) return;
    if (!controls) controls = buildControls();
    const right = SITE.controlsSlot(player);
    if (right) {
      controls.classList.remove('clip-live-floating');
      if (controls.parentNode !== right || right.firstChild !== controls) right.prepend(controls);
    } else {
      controls.classList.add('clip-live-floating');
      if (controls.parentNode !== player) player.appendChild(controls);
    }
    const s = session;
    controls.title = s && s.error
      ? `Clip Live: ${s.error}`
      : `Clip Live: gravando os últimos ${s ? bufferedSeconds(s) : 0}s`
        + (auto.active ? ' · corte automático ligado pelo painel' : '');
    const badge = controls.querySelector('.clip-live-auto');
    if (badge) badge.hidden = !auto.active;
  }

  function removeControls() {
    if (controls && controls.parentNode) controls.remove();
  }

  let toastEl = null;
  let toastTimer = null;

  // ms = 0 deixa o toast até o próximo.
  function toast(text, ms = TOAST_MS) {
    const player = getPlayer();
    if (!player) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'clip-live-toast';
      toastEl.setAttribute('role', 'status');
    }
    if (toastEl.parentNode !== player) player.appendChild(toastEl);
    toastEl.textContent = text;
    toastEl.classList.add('clip-live-show');
    clearTimeout(toastTimer);
    if (ms > 0) toastTimer = setTimeout(() => toastEl.classList.remove('clip-live-show'), ms);
  }

  // ---------- Corte automático pelo chat ----------
  // Lê o chat pelo DOM, conta risadas e, quando a live desta aba está ativa no painel e o chat
  // explode de rir, salva um clipe de 60 s (30 s antes e 30 s depois do pico).

  let autoCfg = { ...AUTO_DEFAULTS };

  const auto = {
    active: false, // a live desta aba está em "ativos" do painel (resposta do service worker)
    painelOk: null,
    painelErro: null,
    lastBeat: 0,
    lastKey: '',
    triggers: [], // instantes dos disparos desta live na última hora (o service worker guarda por id)
    saved: [], // instantes dos clipes automáticos salvos
    lastTrigger: 0,
    pending: null, // { key, at, saveAt, motivo }
    pendingTimer: null,
    lastClip: null, // { arquivo, em, motivo }
    error: null,
  };

  const CHAT_KEYS_MAX = 3000; // conjunto de chaves já contadas (o mais antigo sai primeiro)
  const LATE_MIN = 30; // lote maior que max(30, 5 x a média) chegou atrasado e não conta
  const LATE_MULT = 5;

  const chat = {
    root: null,
    observer: null,
    since: 0, // quando começou a ler este chat (aquecimento)
    events: [], // { t, laugh }
    seen: new WeakSet(),
    keys: new Set(),
    lastLaughBy: new Map(), // autor -> instante da última risada contada
    avgBatch: 0, // média de mensagens novas por lote do observador
    retry: [], // mensagens que chegaram sem texto ainda
    retryTimer: null,
    lateBatches: 0,
  };

  function chatStop() {
    if (chat.observer) chat.observer.disconnect();
    clearTimeout(chat.retryTimer);
    Object.assign(chat, {
      root: null, observer: null, since: 0, events: [], seen: new WeakSet(), keys: new Set(),
      lastLaughBy: new Map(), avgBatch: 0, retry: [], retryTimer: null, lateBatches: 0,
    });
  }

  // Liga o observador no contêiner do chat (ou troca, se o chat foi recriado).
  function chatEnsure() {
    const root = SITE.chatRoot();
    if (root && root === chat.root && root.isConnected) return true;
    if (chat.root) log('chat sumiu ou foi recriado: recomeçando a contagem');
    chatStop();
    if (!root) return false;
    chat.root = root;
    chat.since = Date.now();
    // O que já estava na tela não conta (não sabemos quando foi escrito).
    for (const el of root.querySelectorAll(SITE.msgSel)) readMessage(el);
    chat.observer = new MutationObserver(onChatMutations);
    chat.observer.observe(root, { childList: true, subtree: true });
    log(`lendo o chat (${SITE.label})`);
    return true;
  }

  // Lê autor e texto e marca como visto. Devolve null se já foi contada ou ainda está sem texto.
  function readMessage(el) {
    if (chat.seen.has(el)) return null;
    const text = SITE.msgText(el);
    if (!text) return { empty: true };
    chat.seen.add(el);
    const author = SITE.msgAuthor(el) || '';
    const key = SITE.msgKey(el, text, author);
    if (key) {
      if (chat.keys.has(key)) return null;
      chat.keys.add(key);
      if (chat.keys.size > CHAT_KEYS_MAX) chat.keys.delete(chat.keys.values().next().value);
    }
    return { text, author };
  }

  // O observador não sofre o atraso de timer de aba escondida: conta e decide o disparo aqui,
  // com a hora da chegada.
  function onChatMutations(muts) {
    const t = Date.now();
    const els = [];
    for (const m of muts) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.matches(SITE.msgSel)) els.push(node);
        else for (const el of node.querySelectorAll(SITE.msgSel)) els.push(el);
      }
    }
    if (!els.length) return;
    const msgs = [];
    for (const el of els) {
      const r = readMessage(el);
      if (r && r.empty) chat.retry.push({ el, t });
      else if (r) msgs.push(r);
    }
    // O conteúdo de algumas mensagens entra logo depois do nó: tenta de novo daqui a pouco.
    if (chat.retry.length && !chat.retryTimer) chat.retryTimer = setTimeout(chatRetry, CHAT_FLUSH_MS);
    countBatch(msgs, t);
  }

  function chatRetry() {
    chat.retryTimer = null;
    const list = chat.retry;
    chat.retry = [];
    const msgs = [];
    let t = Date.now();
    for (const { el, t: at } of list) {
      if (!el.isConnected) continue;
      const r = readMessage(el);
      if (r && !r.empty) {
        msgs.push(r);
        t = Math.min(t, at);
      }
    }
    countBatch(msgs, t);
  }

  // Conta um lote. Lote grande demais de uma vez (chat pausado que voltou, chat rolado para cima,
  // aba que voltou a renderizar) é atraso: fica fora da contagem, para não virar pico falso.
  function countBatch(msgs, t) {
    if (!msgs.length) return;
    if (SITE.chatPaused()) return;
    const n = msgs.length;
    if (chat.avgBatch && n > Math.max(LATE_MIN, LATE_MULT * chat.avgBatch)) {
      chat.lateBatches++;
      log(`lote de ${n} mensagens chegou de uma vez (média ${chat.avgBatch.toFixed(1)}): fora da contagem`);
      return;
    }
    if (!chat.avgBatch) {
      // Primeiro lote: vira a média inicial, mas se já vier enorme também é atraso.
      chat.avgBatch = n;
      if (n > LATE_MIN) return;
    } else {
      chat.avgBatch = chat.avgBatch * 0.95 + n * 0.05;
    }
    const win = autoCfg.janela_s * 1000;
    for (const { text, author } of msgs) {
      let laugh = LAUGH_RE.test(text.toLowerCase());
      // No máximo 1 risada por autor por janela: uma pessoa sozinha não faz pico.
      if (laugh && author) {
        const last = chat.lastLaughBy.get(author);
        if (last && t - last < win) laugh = false;
        else chat.lastLaughBy.set(author, t);
      }
      chat.events.push({ t, laugh });
    }
    if (chat.lastLaughBy.size > 2000) {
      for (const [a, at] of chat.lastLaughBy) if (t - at >= win) chat.lastLaughBy.delete(a);
    }
    // Avalia o pico já aqui (o observador não sofre com timer atrasado), mas no máximo 1 vez a cada 500 ms
    // e nunca com corte pendente: em chat muito rápido isso evita varrer a lista dezenas de vezes por segundo.
    if (auto.active && !auto.pending && t - (chat.lastEval || 0) >= 500) {
      chat.lastEval = t;
      maybeTrigger(chatStats(t), t);
    }
  }

  // Números da janela atual do chat.
  function chatStats(now) {
    const c = autoCfg;
    const ev = chat.events;
    const keepFrom = now - (c.base_s + 30) * 1000;
    let drop = 0;
    while (drop < ev.length && ev[drop].t < keepFrom) drop++;
    if (drop) ev.splice(0, drop);
    const win = now - c.janela_s * 1000;
    const baseEnd = now - c.base_folga_s * 1000;
    const baseStart = Math.max(now - c.base_s * 1000, chat.since);
    let msgs = 0;
    let laughs = 0;
    let baseLaughs = 0;
    for (const e of ev) {
      if (e.t > win) {
        msgs++;
        if (e.laugh) laughs++;
      }
      if (e.laugh && e.t >= baseStart && e.t < baseEnd) baseLaughs++;
    }
    // Menos de uma janela de histórico (começo da leitura): divide por uma janela inteira.
    const span = Math.max(baseEnd - baseStart, c.janela_s * 1000);
    const base = baseEnd > baseStart ? baseLaughs / (span / (c.janela_s * 1000)) : 0;
    const warming = !chat.since || now - chat.since < c.aquecimento_s * 1000;
    return { msgs, laughs, base, warming };
  }

  const lastHour = (list, now) => list.filter((t) => now - t < 3600_000);

  // Chamado a cada checagem (2 s): liga ou desliga a leitura do chat, confere o disparo e manda
  // o sinal ao service worker.
  function autoTick(key, live) {
    const now = Date.now();
    if (key !== auto.lastKey) {
      // Mudou de live (raid, outro canal na mesma aba): zera o chat, o estado e o corte pendente,
      // que era da live anterior.
      if (auto.lastKey && !key) sendGone();
      chatStop();
      clearTimeout(auto.pendingTimer);
      Object.assign(auto, {
        lastKey: key, active: false, lastBeat: 0, triggers: [], saved: [], lastClip: null,
        error: null, pending: null, pendingTimer: null, lastTrigger: 0,
      });
    }
    // Só lê o chat com a live ativa no painel (o aquecimento começa ao ativar).
    if (live && auto.active) chatEnsure();
    else if (chat.root) chatStop();

    auto.triggers = lastHour(auto.triggers, now);
    auto.saved = lastHour(auto.saved, now);
    if (live && chat.root && auto.active) maybeTrigger(chatStats(now), now);
    if (key && now - auto.lastBeat >= HEARTBEAT_MS) {
      auto.lastBeat = now;
      sendHeartbeat(key);
    }
  }

  // "now" é o instante do pico (vem do observador do chat ou da checagem de 2 s).
  function maybeTrigger(st, now) {
    const c = autoCfg;
    if (!auto.active || auto.pending || st.warming) return;
    if (!session || session.error || session.key !== auto.lastKey) return;
    if (now - auto.lastTrigger < c.pausa_s * 1000) return;
    if (lastHour(auto.triggers, now).length >= c.max_hora) return;
    const need = Math.max(c.minimo, c.multiplicador * st.base + c.extra);
    if (st.laughs < need || st.laughs < c.proporcao * st.msgs) return;
    const normal = String(Math.round(st.base * 10) / 10).replace('.', ',');
    const motivo = `${st.laughs} risadas em ${c.janela_s} s (o normal é ${normal})`;
    const key = auto.lastKey;
    auto.lastTrigger = now;
    auto.triggers.push(now);
    auto.pending = { key, at: now, saveAt: now + c.espera_s * 1000, motivo };
    auto.lastBeat = 0; // manda o status novo logo
    log(`corte automático: pico no chat (${motivo}, ${st.msgs} mensagens), salvando em ${c.espera_s} s`);
    // O limite por hora fica no service worker, por live (F5 ou troca de aba não zera).
    try { chrome.runtime.sendMessage({ type: 'auto-disparo', id: key, em: now }).catch(() => {}); } catch (e) { /* nada */ }
    clearTimeout(auto.pendingTimer);
    auto.pendingTimer = setTimeout(() => runAutoClip(0), Math.max(0, auto.pending.saveAt - Date.now()));
  }

  async function runAutoClip(tries) {
    const p = auto.pending;
    if (!p || dead) return;
    // Durante um reinício do pipeline (anúncio, <video> novo) a sessão some por até 10 s e o buffer fica em `kept`.
    const s = session || kept;
    if (!s) {
      if (tries < 12) {
        auto.pendingTimer = setTimeout(() => runAutoClip(tries + 1), 1000);
      } else {
        auto.pending = null;
        auto.error = 'Corte automático perdido: a gravação estava reiniciando na hora de salvar';
        auto.lastBeat = 0;
      }
      return;
    }
    // A aba mudou de live depois do pico: o corte era da outra live, descarta.
    if (s.key !== p.key || auto.lastKey !== p.key) {
      auto.pending = null;
      return;
    }
    // Um clipe manual está sendo montado: tenta de novo daqui a 1 s (até 20 vezes).
    if (clipping && tries < 20) {
      auto.pendingTimer = setTimeout(() => runAutoClip(tries + 1), 1000);
      return;
    }
    try {
      const res = await clip(autoCfg.clipe_s, { auto: true, motivo: p.motivo });
      if (res && res.ok) {
        auto.saved.push(Date.now());
        auto.lastClip = { arquivo: res.file, em: localIso(new Date()), motivo: p.motivo };
        auto.error = null;
      } else {
        auto.error = 'Corte automático falhou: ' + (res ? res.error : 'sem resposta');
      }
    } catch (e) {
      auto.error = 'Corte automático falhou: ' + String(e && e.message || e);
    } finally {
      if (auto.pending === p) auto.pending = null;
      auto.lastBeat = 0;
    }
  }

  const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);

  // Estado desta aba no formato do contrato (item 3, auto-clip-status.json).
  function autoStatus(key) {
    if (!key) return null;
    const now = Date.now();
    const st = chat.root ? chatStats(now) : { msgs: 0, laughs: 0, base: 0, warming: true };
    const s = session;
    let erro = fatalError || (s && s.error) || auto.error || null;
    if (!erro && !enabled) erro = 'Clip Live desligado no popup';
    else if (!erro && !s) erro = 'Nenhuma live gravando nesta aba';
    return {
      id: key,
      url: cut(SITE.liveUrl(key), 200),
      canal: cut(channelName(), 80),
      ativo: auto.active,
      gravando: !!s && !s.error && enabled,
      buffer_s: s && !s.error ? bufferedSeconds(s) : 0,
      oculta: document.hidden,
      chat: !!chat.root,
      msgs_10s: st.msgs,
      risadas_10s: st.laughs,
      base_10s: Math.round(st.base * 10) / 10,
      aquecendo: st.warming,
      proximo_clipe_em: auto.pending ? localIso(new Date(auto.pending.saveAt)) : null,
      ultimo_clipe: auto.lastClip
        ? { arquivo: cut(auto.lastClip.arquivo, 120), em: auto.lastClip.em, motivo: cut(auto.lastClip.motivo, 120) }
        : null,
      clipes_hora: lastHour(auto.saved, now).length,
      erro: cut(erro, 160),
    };
  }

  // Sinal ao service worker: manda o status e recebe se a live está ativa no painel.
  async function sendHeartbeat(key) {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'auto-status', aba: autoStatus(key) });
      if (dead || key !== auto.lastKey) return;
      const was = auto.active;
      auto.active = !!(res && res.ativo);
      // Disparos desta live na última hora, guardados no service worker (sobrevivem a F5).
      if (res && Array.isArray(res.disparos)) {
        const all = new Set([...auto.triggers, ...res.disparos.filter((x) => typeof x === 'number')]);
        auto.triggers = lastHour([...all].sort((x, y) => x - y), Date.now());
      }
      auto.painelOk = res ? res.painel : null;
      auto.painelErro = res ? res.erro : null;
      if (was !== auto.active) {
        log(auto.active ? 'corte automático ligado pelo painel' : 'corte automático desligado');
        if (controls && controls.parentNode) ensureControls(getPlayer());
      }
    } catch (e) {
      auto.active = false;
    }
  }

  // Avisa o service worker que esta aba saiu da live.
  function sendGone() {
    try { chrome.runtime.sendMessage({ type: 'auto-status', aba: null }).catch(() => {}); } catch (e) { /* nada */ }
  }

  // Opção de depuração (desligada por padrão): chrome.storage.local autoClipDebug = { minimo: 2, ... }.
  function applyDebug(v) {
    autoCfg = { ...AUTO_DEFAULTS };
    if (v && typeof v === 'object') {
      for (const k of Object.keys(AUTO_DEFAULTS)) {
        if (typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0) autoCfg[k] = v[k];
      }
      log('corte automático com números de depuração', JSON.stringify(autoCfg));
    }
  }

  // ---------- Mensagens ----------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (dead || !msg || typeof msg !== 'object') return false;
    if (msg.type === 'status') {
      sendResponse(statusOf(session));
      return false;
    }
    if (msg.type === 'clip') {
      clip(msg.seconds).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    return false;
  });

  // ---------- Início ----------

  function onNavigate() {
    setTimeout(check, 300);
  }

  // Se outra cópia deste script já roda neste mundo (injeção ao recarregar a extensão), desliga ela.
  if (typeof globalThis.__clipLiveTeardown === 'function') {
    try { globalThis.__clipLiveTeardown(); } catch (e) { /* nada */ }
  }
  globalThis.__clipLiveTeardown = teardown;

  // Liga/desliga: lê o estado salvo e reage na hora quando o popup muda.
  function onStorageChange(changes, area) {
    if (dead || area !== 'local') return;
    if (changes.autoClipDebug) applyDebug(changes.autoClipDebug.newValue);
    if (!changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    log(enabled ? 'ligada pelo usuário' : 'desligada pelo usuário');
    check();
  }

  if (checkSupport()) {
    document.addEventListener('yt-navigate-finish', onNavigate);
    try { chrome.storage.onChanged.addListener(onStorageChange); } catch (e) { /* nada */ }
    checkInterval = setInterval(check, CHECK_MS);
    chrome.storage.local.get({ enabled: true, autoClipDebug: null })
      .then((v) => {
        enabled = v.enabled !== false;
        if (v.autoClipDebug) applyDebug(v.autoClipDebug);
      })
      .catch(() => { /* sem storage: fica ligada */ })
      .finally(check);
  }
})();
