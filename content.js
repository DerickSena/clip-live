/*
 * Clip Live: replay buffer de lives do YouTube.
 * Enquanto a live toca, codifica o vídeo do player (WebCodecs) e guarda só os
 * últimos BUFFER_SECONDS de conteúdo. Num clique, monta um MP4 com os últimos 30 s ou 60 s.
 *
 * O YouTube exige Trusted Types: nada de innerHTML, todo DOM é montado com createElement.
 */
(() => {
  'use strict';

  const BUFFER_SECONDS = 70;
  const KEYFRAME_INTERVAL_US = 1_000_000;
  const MIN_FRAME_GAP_US = 1000; // frame com timestamp repetido (ou quase) é descartado
  const GAP_US = 500_000; // mesmo valor do mux.js: intervalo maior é "buraco"
  const MAX_VIDEO_QUEUE = 8;
  const MAX_AUDIO_QUEUE = 500; // alto de propósito: o AAC do Windows segura muitos itens na fila
  const MAX_SIDE = 1920;
  const ASPECT_TOLERANCE = 0.05;
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

  // ---------- Detecção da live ----------

  const getPlayer = () => document.querySelector('#movie_player');
  const getVideo = () => document.querySelector('#movie_player video.html5-main-video')
    || document.querySelector('video.html5-main-video');

  function pageKey() {
    const p = location.pathname;
    if (p === '/watch') return 'watch:' + (new URLSearchParams(location.search).get('v') || '');
    if (p.startsWith('/live/')) return 'live:' + p.slice(6);
    return '';
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

  function isLive(player, video) {
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
  }

  const isAd = (player) => !!player && player.classList.contains('ad-showing');

  // Pausado, buscando ou sem dados à frente (HAVE_FUTURE_DATA): o que chega é frame congelado.
  const isStalled = (video) => video.paused || video.seeking || video.readyState < 3;

  function check() {
    try {
      if (dead || fatalError) return;
      if (!runtimeAlive()) {
        teardown();
        return;
      }
      // Desligada pelo popup: não grava nada e não mostra botões (economiza processador).
      if (!enabled) {
        if (session || kept) log('desligada pelo usuário, parando');
        stopSession();
        kept = null;
        removeControls();
        return;
      }
      const key = pageKey();
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
        return;
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
    } catch (e) {
      warn('erro na checagem', e);
    }
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
      // Tamanho fixo por sessão; só muda de época se a proporção mudar.
      if (!s.venc || aspectChanged(s, w, h)) {
        if (!s.vConfiguring) configureVideo(s, w, h);
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

  // Primeiro frame de live (ou proporção nova) = novo encoder e nova época.
  async function configureVideo(s, w, h) {
    s.vConfiguring = true;
    try {
      closeCoder(s.venc);
      s.venc = null;
      // Mantém o tamanho fixo se já existe (reinício) e a proporção é a mesma.
      const keepSize = !!s.encW && !aspectChanged(s, w, h);
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
      detect: detectInfo(),
    };
  }

  // Diagnóstico da detecção de live, para o popup explicar por que não está gravando.
  function detectInfo() {
    const player = getPlayer();
    const badge = player && player.querySelector('.ytp-live-badge');
    const video = getVideo();
    return {
      page: pageKey() || location.pathname,
      player: !!player,
      video: !!video,
      badge: badge ? getComputedStyle(badge).display : 'ausente',
      ytpLive: !!player && player.classList.contains('ytp-live'),
      meta: !!document.querySelector('meta[itemprop="isLiveBroadcast"]'),
      endDate: !!document.querySelector('meta[itemprop="endDate"]'),
      duration: video ? String(video.duration) : null,
      live: isLive(player),
    };
  }

  // ---------- Clipe ----------

  async function clip(seconds) {
    seconds = seconds === 60 ? 60 : 30;
    if (clipping) {
      toast('Já estou montando um clipe, espere um pouco');
      return { ok: false, error: 'ocupado' };
    }
    const s = session || kept;
    if (!s) {
      toast(fatalError || 'Abra uma live do YouTube para clipar');
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
      const filename = buildFilename(clickedAt, seconds);
      const how = await download(buf, filename);

      let msg;
      if (dur < seconds - 1 && epochChanged) msg = `Clipe com ${dur}s salvo (o formato do vídeo mudou)`;
      else if (dur < seconds - 1) msg = `Clipe com ${dur}s salvo (só tinha isso gravado)`;
      else msg = `Clipe de ${seconds}s salvo`;
      if (!sel.audio.length) msg += ', sem som';
      toast(msg);
      log(`clipe: ${dur}s, ${sel.video.length} frames, ${sel.audio.length} pacotes de áudio, ${sel.gaps} buraco(s) comprimido(s), ${buf.byteLength} bytes, via ${how}`);
      return { ok: true, seconds: dur, filename, message: msg };
    } catch (e) {
      console.error(TAG, 'falha ao montar clipe', e);
      toast('Não consegui montar o clipe (veja o console)');
      return { ok: false, error: String(e && e.message || e) };
    } finally {
      clipping = false;
    }
  }

  function channelName() {
    const sels = [
      '#owner ytd-channel-name a',
      'ytd-video-owner-renderer #channel-name a',
      '[itemprop="author"] link[itemprop="name"]',
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      const txt = el && (el.textContent || el.getAttribute('content') || '').trim();
      if (txt) return txt;
    }
    return 'youtube';
  }

  function sanitize(name) {
    const out = name
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
      .replace(/\s+/g, '-')
      .replace(/^[.\s-]+/g, '')
      .slice(0, 40)
      .replace(/[.\s-]+$/g, '');
    return out || 'youtube';
  }

  function buildFilename(d, seconds) {
    const p = (n) => String(n).padStart(2, '0');
    const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const time = `${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
    return `clip-live/${sanitize(channelName())}_${date}_${time}_${seconds}s.mp4`;
  }

  // Tenta pelo service worker (subpasta clip-live/); se falhar, cai para <a download>.
  async function download(buf, filename) {
    const url = URL.createObjectURL(new Blob([buf], { type: 'video/mp4' }));
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
    const right = player.querySelector('.ytp-right-controls');
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
      : `Clip Live: gravando os últimos ${s ? bufferedSeconds(s) : 0}s`;
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
    if (dead || area !== 'local' || !changes.enabled) return;
    enabled = changes.enabled.newValue !== false;
    log(enabled ? 'ligada pelo usuário' : 'desligada pelo usuário');
    check();
  }

  if (checkSupport()) {
    document.addEventListener('yt-navigate-finish', onNavigate);
    try { chrome.storage.onChanged.addListener(onStorageChange); } catch (e) { /* nada */ }
    checkInterval = setInterval(check, CHECK_MS);
    chrome.storage.local.get({ enabled: true })
      .then((v) => { enabled = v.enabled !== false; })
      .catch(() => { /* sem storage: fica ligada */ })
      .finally(check);
  }
})();
