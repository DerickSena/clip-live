/*
 * Clip Live: escolhe o trecho do clipe e monta o MP4 (Mediabunny).
 * Script clássico: cria o global ClipLiveMux (content script) e também exporta
 * para o Node (usado no teste em tools/test-mux.js).
 */
var ClipLiveMux = (() => {
  'use strict';

  // Intervalo entre frames acima disso é "buraco" (pausa, anúncio, aba travada).
  const GAP_US = 500_000;
  // Distância mínima entre dois timestamps da mesma track no MP4 (evita DTS repetido).
  const MIN_STEP_US = 1000;
  const DEFAULT_STEP_US = 33_333;

  // Duração de um frame normal: mediana dos intervalos recentes fora de buracos.
  function frameStep(video) {
    const deltas = [];
    for (let i = video.length - 1; i > 0 && deltas.length < 120; i--) {
      const d = video[i].timestamp - video[i - 1].timestamp;
      if (d > 0 && d <= GAP_US) deltas.push(d);
    }
    if (!deltas.length) return DEFAULT_STEP_US;
    deltas.sort((a, b) => a - b);
    return Math.min(100_000, Math.max(8_333, deltas[deltas.length >> 1]));
  }

  // Tempo "comprimido" de cada frame: cada buraco vira a duração de um frame normal.
  function compressedTimes(video, step) {
    const c = new Array(video.length);
    c[0] = 0;
    for (let i = 1; i < video.length; i++) {
      const d = video[i].timestamp - video[i - 1].timestamp;
      c[i] = c[i - 1] + (d > GAP_US ? step : Math.max(0, d));
    }
    return c;
  }

  // Duração de conteúdo real (sem buracos) de uma lista de frames, em us.
  function contentDuration(video) {
    if (video.length < 2) return 0;
    const c = compressedTimes(video, frameStep(video));
    return c[c.length - 1];
  }

  /**
   * Escolhe os últimos `seconds` de conteúdo (tempo comprimido), começando num keyframe.
   * video: [{chunk|packet, timestamp (us), key}] em ordem, mesma época
   * audio: [{chunk|packet, timestamp (us), duration (us)}] em ordem
   * Retorna { video, audio, durationUs, gaps } com timestamps relativos (us, começando em 0),
   * estritamente crescentes por track. Áudio dentro de buraco é descartado.
   */
  function selectClip(video, audio, seconds) {
    let start = video.findIndex((r) => r.key);
    if (start < 0) return null;
    const step = frameStep(video);
    const c = compressedTimes(video, step);
    const target = c[c.length - 1] - seconds * 1e6;
    for (let i = start; i < video.length && c[i] <= target; i++) {
      if (video[i].key) start = i;
    }
    const base = c[start];

    const vOut = [];
    let gaps = 0;
    let last = -Infinity;
    for (let i = start; i < video.length; i++) {
      if (i > start && video[i].timestamp - video[i - 1].timestamp > GAP_US) gaps++;
      let t = c[i] - base;
      if (t < last + MIN_STEP_US) t = last + MIN_STEP_US;
      last = t;
      vOut.push(Object.assign({}, video[i], { timestamp: t }));
    }

    const aOut = [];
    let lastA = -Infinity;
    let j = start;
    const first = video[start].timestamp;
    for (const a of audio) {
      if (a.timestamp < first) continue;
      while (j + 1 < video.length && video[j + 1].timestamp <= a.timestamp) j++;
      const off = a.timestamp - video[j].timestamp;
      const next = j + 1 < video.length ? video[j + 1].timestamp - video[j].timestamp : step;
      const limit = next > GAP_US ? step : next;
      if (off >= limit) continue; // dentro de um buraco (ou depois do último frame)
      const t = c[j] - base + off;
      if (t < lastA + MIN_STEP_US) continue;
      lastA = t;
      aOut.push(Object.assign({}, a, { timestamp: t }));
    }

    return { video: vOut, audio: aOut, durationUs: last + step, gaps };
  }

  /**
   * Linha do tempo do áudio codificado. O AudioEncoder (AAC do Windows) não respeita o
   * timestamp de cada AudioData: conta amostras desde o primeiro input, então pausa e
   * descarte viram áudio "colado". Aqui cada AudioData enviado entra numa fila com seu
   * timestamp e nº de amostras; cada chunk de saída avança a posição em amostras e o
   * timestamp é lido da entrada que contém essa posição. Um buraco na entrada vira
   * buraco na saída, sem precisar de flush() (que ainda acrescentaria enchimento).
   */
  function createAudioTimeline(sampleRate) {
    const q = [];
    let inPos = 0;
    let outPos = 0;
    return {
      // Registra um AudioData enviado ao encoder (timestamp em us).
      push(timestamp, frames) {
        q.push({ timestamp, start: inPos, frames });
        inPos += frames;
      },
      // Próximo chunk de saída com `frames` amostras: { timestamp, duration } em us.
      next(frames) {
        const pos = outPos;
        outPos += frames;
        while (q.length > 1 && q[0].start + q[0].frames <= pos) q.shift();
        const e = q[0];
        if (!e) return null;
        return {
          timestamp: Math.round(e.timestamp + ((pos - e.start) * 1e6) / sampleRate),
          duration: Math.round((frames * 1e6) / sampleRate),
        };
      },
      get pendingFrames() { return inPos - outPos; },
    };
  }

  // Converte um registro em EncodedPacket com timestamp relativo (em segundos).
  function toPacket(MB, rec, t0Us, durationUs) {
    const base = rec.packet || MB.EncodedPacket.fromEncodedChunk(rec.chunk);
    return base.clone({
      timestamp: (rec.timestamp - t0Us) / 1e6,
      duration: Math.max(0, durationUs) / 1e6,
    });
  }

  /**
   * Monta o MP4.
   * opts.video: [{chunk|packet, timestamp (us), key}] em ordem de decodificação, começando num keyframe
   * opts.audio: [{chunk|packet, timestamp (us), duration (us)}] com timestamp >= o do primeiro frame
   * opts.videoConfig / opts.audioConfig: decoderConfig vindos do encoder
   * opts.audioCodec: 'aac' | 'opus' | null
   * Retorna ArrayBuffer.
   */
  async function buildMp4(MB, opts) {
    const { video, audio = [], videoConfig, audioConfig, audioCodec } = opts;
    if (!video.length) throw new Error('sem vídeo');
    const t0 = video[0].timestamp;

    const target = new MB.BufferTarget();
    const output = new MB.Output({
      format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    });
    // Sem frameRate de propósito: ele "encaixa" os timestamps numa grade e
    // frames do captureStream com espaçamento irregular poderiam colidir.
    const vSource = new MB.EncodedVideoPacketSource('avc');
    output.addVideoTrack(vSource);

    const useAudio = !!(audioCodec && audioConfig && audio.length);
    let aSource = null;
    if (useAudio) {
      aSource = new MB.EncodedAudioPacketSource(audioCodec);
      output.addAudioTrack(aSource);
    }
    await output.start();

    // Duração de cada frame = distância até o próximo (o último repete a anterior).
    const vDur = (i) => {
      if (i + 1 < video.length) return video[i + 1].timestamp - video[i].timestamp;
      if (i > 0) return video[i].timestamp - video[i - 1].timestamp;
      return DEFAULT_STEP_US;
    };
    const aDur = (i) => audio[i].duration || 21333;

    // Intercala por timestamp: o Mediabunny segura uma faixa que adianta demais em relação à outra.
    let vi = 0;
    let ai = 0;
    const aList = useAudio ? audio : [];
    while (vi < video.length || ai < aList.length) {
      const takeVideo = ai >= aList.length
        || (vi < video.length && video[vi].timestamp <= aList[ai].timestamp);
      if (takeVideo) {
        const pkt = toPacket(MB, video[vi], t0, vDur(vi));
        await vSource.add(pkt, vi === 0 ? { decoderConfig: videoConfig } : undefined);
        vi++;
      } else {
        const pkt = toPacket(MB, aList[ai], t0, aDur(ai));
        await aSource.add(pkt, ai === 0 ? { decoderConfig: audioConfig } : undefined);
        ai++;
      }
    }

    await output.finalize();
    return target.buffer;
  }

  return { buildMp4, selectClip, contentDuration, frameStep, createAudioTimeline, GAP_US };
})();

if (typeof module === 'object' && typeof module.exports === 'object') module.exports = ClipLiveMux;
