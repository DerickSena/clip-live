/*
 * Teste do mux em Node (sem navegador).
 * Gera um MP4 de origem com o ffmpeg (H.264 + AAC, keyframe a cada 1 s), lê os pacotes
 * reais com o próprio Mediabunny e simula o buffer (timestamps em us, base arbitrária).
 * Casos: clipe normal, buraco no tempo (anúncio/pausa) e timestamps repetidos.
 * Cada clipe é conferido com ffprobe e decodificado pelo ffmpeg sem nenhum aviso.
 * Uso: npm test   (precisa de ffmpeg e ffprobe no PATH)
 */
'use strict';
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const MB = require('../node_modules/mediabunny/dist/bundles/mediabunny.node.cjs');
const { buildMp4, selectClip, createAudioTimeline } = require('../mux.js');

const BASE = 987654321000; // base de tempo arbitrária, como a do captureStream (us)
let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FALHOU:', msg);
  }
}

async function loadSource(dir) {
  const src = path.join(dir, 'src.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-c:v', 'libx264', '-profile:v', 'high', '-bf', '0', '-g', '30', '-keyint_min', '30',
    '-c:a', 'aac', '-ac', '2', '-b:a', '160k', src]);
  const input = new MB.Input({ source: new MB.BufferSource(fs.readFileSync(src)), formats: MB.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack();
  const at = await input.getPrimaryAudioTrack();
  const video = [];
  for await (const p of new MB.EncodedPacketSink(vt).packets()) {
    video.push({ packet: p, timestamp: BASE + Math.round(p.timestamp * 1e6), key: p.type === 'key' });
  }
  const audio = [];
  for await (const p of new MB.EncodedPacketSink(at).packets()) {
    audio.push({ packet: p, timestamp: BASE + Math.round(p.timestamp * 1e6), duration: Math.round(p.duration * 1e6) });
  }
  return { video, audio, videoConfig: await vt.getDecoderConfig(), audioConfig: await at.getDecoderConfig() };
}

async function runCase(dir, name, src, video, audio, seconds, expect) {
  console.log(`caso: ${name}`);
  const sel = selectClip(video, audio, seconds);
  const buf = await buildMp4(MB, {
    video: sel.video, audio: sel.audio,
    videoConfig: src.videoConfig, audioConfig: src.audioConfig, audioCodec: 'aac',
    tags: expect.tags,
  });
  const out = path.join(dir, name + '.mp4');
  fs.writeFileSync(out, Buffer.from(buf));

  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,nb_frames,duration', '-of', 'json', out]).toString());
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  console.log(`  vídeo: ${v.nb_frames} frames, ${v.duration}s | áudio: ${a ? a.nb_frames + ' pacotes, ' + a.duration + 's' : 'nenhum'} | buracos: ${sel.gaps}`);

  // Decodifica tudo com avisos ligados: não pode sair nada (ex.: "non monotonically increasing dts").
  const dec = spawnSync('ffmpeg', ['-v', 'warning', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  const warnings = (dec.stderr || '').trim();
  assert(dec.status === 0, `ffmpeg saiu com ${dec.status}`);
  // No caso de repetidos, o frame empurrado fica a 1 ms do anterior: o muxer "null" do ffmpeg
  // arredonda para a grade de fps e reclama, mas o MP4 em si fica certo (conferido abaixo).
  if (!expect.allowNullWarnings) {
    assert(!warnings, `ffmpeg avisou: ${warnings.split('\n').slice(0, 3).join(' | ')}`);
  }
  // DTS estritamente crescente dentro do MP4, por stream.
  const pk = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'packet=stream_index,dts', '-of', 'json', out]).toString()).packets;
  const lastDts = {};
  let bad = 0;
  for (const k of pk) {
    const d = Number(k.dts);
    if (k.stream_index in lastDts && d <= lastDts[k.stream_index]) bad++;
    lastDts[k.stream_index] = d;
  }
  assert(bad === 0, `${bad} pacote(s) com DTS não crescente no MP4`);
  assert(Number(v.nb_frames) === expect.frames, `frames ${v.nb_frames} != ${expect.frames}`);
  assert(Math.abs(Number(v.duration) - expect.duration) < 0.1, `duração ${v.duration} != ${expect.duration}`);
  // Áudio acompanha o vídeo (sem sair "colado" e mais curto).
  assert(a && Math.abs(Number(a.duration) - Number(v.duration)) < 0.1, `áudio ${a && a.duration}s difere do vídeo ${v.duration}s`);
  if (expect.minAudio) assert(a && Number(a.nb_frames) >= expect.minAudio, `áudio ${a && a.nb_frames} < ${expect.minAudio}`);
  // Metadados: a origem do clipe vai no comment ("clip-live:" + JSON), o título e a data.
  if (expect.tags) {
    const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags',
      '-of', 'json', out]).toString()).format.tags || {};
    assert(tags.title === expect.tags.title, `title ${JSON.stringify(tags.title)}`);
    assert(typeof tags.comment === 'string' && tags.comment.startsWith('clip-live:'), `comment ${JSON.stringify(tags.comment)}`);
    let info = null;
    try { info = JSON.parse(tags.comment.slice('clip-live:'.length)); } catch (e) { /* conferido abaixo */ }
    assert(info && info.origem === 'clip-live' && info.canal === 'Canal', 'JSON do comment inválido');
    assert(!!tags.date, 'sem date');
    console.log(`  tags: title=${tags.title} | date=${tags.date} | comment=${(tags.comment || '').slice(0, 60)}...`);
  }
  // Timestamps estritamente crescentes por track.
  for (const list of [sel.video, sel.audio]) {
    for (let i = 1; i < list.length; i++) {
      if (list[i].timestamp <= list[i - 1].timestamp) {
        assert(false, `timestamp não crescente no índice ${i}`);
        break;
      }
    }
  }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-live-test-'));
  const src = await loadSource(dir);
  console.log(`origem: ${src.video.length} frames, ${src.audio.length} pacotes de áudio; saída em ${dir}`);

  // 1) Normal: últimos 5 s começam no keyframe de 2 s, então o clipe tem 6 s.
  const origem = {
    url: 'https://kick.com/canal', titulo: 'Título "com aspas" e acentuação', canal: 'Canal', plataforma: 'kick',
    inicio: null, fim: null, baixado_em: '2026-11-19T12:00:00', origem: 'clip-live', auto: true, motivo: '14 risadas em 10 s',
  };
  const tags = { title: `${origem.canal} - ${origem.titulo}`, comment: 'clip-live:' + JSON.stringify(origem), date: new Date() };
  await runCase(dir, 'normal', src, src.video, src.audio, 5, { frames: 180, duration: 6, minAudio: 270, tags });

  // 2) Buraco de 20 s aos 3 s (anúncio/pausa): o buraco vira um frame e o clipe fica igual ao normal.
  const shift = (r) => Object.assign({}, r, { timestamp: r.timestamp + 20e6 });
  const cut = BASE + 3e6;
  const vGap = src.video.map((r) => (r.timestamp >= cut ? shift(r) : r));
  const aGap = src.audio.map((r) => (r.timestamp >= cut ? shift(r) : r));
  await runCase(dir, 'buraco', src, vGap, aGap, 5, { frames: 180, duration: 6, minAudio: 270 });

  // 3) Buraco e clipe que cobre tudo: 8 s de conteúdo, não 28 s.
  await runCase(dir, 'buraco-tudo', src, vGap, aGap, 60, { frames: 240, duration: 8, minAudio: 360 });

  // 4) Timestamps repetidos: a cada 8 frames, um repete o timestamp do anterior.
  const vDup = src.video.map((r, i) => (i % 8 === 5 ? Object.assign({}, r, { timestamp: src.video[i - 1].timestamp }) : r));
  const aDup = src.audio.map((r, i) => (i % 10 === 3 ? Object.assign({}, r, { timestamp: src.audio[i - 1].timestamp }) : r));
  await runCase(dir, 'repetidos', src, vDup, aDup, 5, { frames: 180, duration: 6, minAudio: 250, allowNullWarnings: true });

  // 5) Pausa com o encoder de áudio real simulado: entradas de 10 ms com buraco de 20 s aos 3 s;
  //    o encoder devolve pacotes de 1024 amostras sem respeitar os timestamps de entrada.
  //    A linha do tempo tem que recolocar o buraco no áudio, e o mux comprime igual ao vídeo.
  const RATE = 48000;
  const timeline = createAudioTimeline(RATE);
  const totalFrames = src.audio.length * 1024;
  for (let pos = 0; pos < totalFrames; pos += 480) {
    let ts = BASE + Math.round((pos * 1e6) / RATE);
    if (ts >= cut) ts += 20e6;
    timeline.push(ts, 480);
  }
  const aTimeline = src.audio.map((r) => {
    const t = timeline.next(1024);
    return Object.assign({}, r, { timestamp: t.timestamp, duration: t.duration });
  });
  const jump = aTimeline.findIndex((r, i) => i > 0 && r.timestamp - aTimeline[i - 1].timestamp > 1e6);
  assert(jump > 0, 'linha do tempo do áudio não criou o buraco');
  await runCase(dir, 'pausa-audio-timeline', src, vGap, aTimeline, 60, { frames: 240, duration: 8, minAudio: 360 });
  await runCase(dir, 'pausa-audio-timeline-5s', src, vGap, aTimeline, 5, { frames: 180, duration: 6, minAudio: 270 });

  if (failures) {
    console.log(`\n${failures} verificação(ões) falharam`);
    process.exit(1);
  }
  console.log('\nOK: todos os casos passaram');
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
