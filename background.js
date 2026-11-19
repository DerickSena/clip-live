/*
 * Clip Live: service worker.
 * Faz o download na subpasta clip-live/, repassa os atalhos para a aba ativa e conversa
 * com o painel (Pérola Painel) sobre o corte automático: consulta quais lives estão ativas,
 * responde a cada aba se ela está ativa, manda o status das abas e abre a live ativa sem aba.
 */
'use strict';

const TAG = '[clip-live]';
const DOWNLOAD_WAIT_MS = 20_000;

// Espera o download terminar. Só "complete" conta como sucesso; interrompido ou
// sem resposta em 20 s é falha (o content script cai no <a download>).
function waitDownload(id) {
  return new Promise((resolve) => {
    let finished = false;
    const done = (result) => {
      if (finished) return;
      finished = true;
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
      resolve(result);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') done({ ok: true, id });
      else if (delta.state.current === 'interrupted') done({ ok: false, error: 'download interrompido' });
    };
    const timer = setTimeout(() => done({ ok: false, error: 'download não terminou em 20 s', timeout: true }), DOWNLOAD_WAIT_MS);
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (!item) return;
      if (item.state === 'complete') done({ ok: true, id });
      else if (item.state === 'interrupted') done({ ok: false, error: 'download interrompido: ' + (item.error || '') });
    }).catch(() => {});
  });
}

async function handleDownload(msg) {
  try {
    const id = await chrome.downloads.download({
      url: msg.url,
      filename: msg.filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    if (id === undefined) {
      return { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : 'sem id' };
    }
    const res = await waitDownload(id);
    if (!res.ok) {
      // Cancela (para não sair arquivo duplicado com o fallback) e tira a entrada da lista.
      if (res.timeout) {
        await chrome.downloads.cancel(id).catch(() => {});
        // Pode ter terminado bem na hora do cancel: aí conta como sucesso.
        const [item] = await chrome.downloads.search({ id }).catch(() => []);
        if (item && item.state === 'complete') return { ok: true, id };
      }
      chrome.downloads.erase({ id }).catch(() => {});
    }
    return res;
  } catch (e) {
    console.warn(TAG, 'download falhou', e);
    return { ok: false, error: String(e && e.message || e) };
  }
}

const SITE_ORIGINS = ['https://www.youtube.com', 'https://www.twitch.tv', 'https://kick.com'];
const SITE_PATTERNS = SITE_ORIGINS.map((o) => o + '/*');

// Só aceita pedido de download vindo desta extensão, com blob de um dos 3 sites (o mesmo da aba)
// e nome esperado: clip-live/<nome>.mp4 ou .json, sem ".." e sem outra subpasta.
function validDownload(msg, sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab) return false;
  if (typeof msg.url !== 'string' || typeof msg.filename !== 'string') return false;
  const origin = SITE_ORIGINS.find((o) => msg.url.startsWith('blob:' + o + '/'));
  if (!origin || sender.origin !== origin) return false;
  return msg.filename.startsWith('clip-live/') && /\.(mp4|json)$/.test(msg.filename)
    && !msg.filename.includes('..') && !msg.filename.slice('clip-live/'.length).includes('/');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  if (msg.type === 'download') {
    if (!validDownload(msg, sender)) {
      sendResponse({ ok: false, error: 'pedido de download recusado' });
      return false;
    }
    handleDownload(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'auto-status' && sender.tab) {
    onTabStatus(sender.tab, msg.aba).then(sendResponse, () => sendResponse({ ativo: false, painel: false }));
    return true;
  }
  if (msg.type === 'auto-disparo' && sender.tab) {
    registrarDisparo(msg.id, msg.em).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'painel-status') {
    getPainel().then((p) => sendResponse({
      ok: p.ok, erro: p.erro, url: p.url, max: p.max, ativos: p.ativos.map((a) => a.id),
    }));
    return true;
  }
  return false;
});

async function sendClip(seconds, tab) {
  try {
    let tabId = tab && tab.id;
    if (tabId === undefined) {
      const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = active && active.id;
    }
    if (tabId === undefined) return;
    await chrome.tabs.sendMessage(tabId, { type: 'clip', seconds });
  } catch (e) {
    // Aba sem o content script (não é YouTube, Twitch nem Kick): nada a fazer.
    console.warn(TAG, 'atalho sem aba de live', e);
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'clip-30') sendClip(30, tab);
  else if (command === 'clip-60') sendClip(60, tab);
});

// Ao instalar ou recarregar a extensão, o navegador não coloca o content script
// nas abas que já estavam abertas. Injeta nas abas abertas dos 3 sites para não precisar de F5.
chrome.runtime.onInstalled.addListener(async (details) => {
  // Só na instalação ou atualização da extensão (não na do navegador).
  if (!details || (details.reason !== 'install' && details.reason !== 'update')) return;
  try {
    const tabs = await chrome.tabs.query({ url: SITE_PATTERNS });
    for (const tab of tabs) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/mediabunny.min.js', 'mux.js', 'content.js'],
        });
        console.log(TAG, 'injetado na aba aberta', tab.id);
      } catch (e) {
        console.warn(TAG, 'não deu para injetar na aba', tab.id, e);
      }
    }
  } catch (e) {
    console.warn(TAG, 'falha ao listar abas abertas', e);
  }
});

// Selo "OFF" no ícone quando a gravação está desligada pelo popup.
async function updateBadge() {
  try {
    const { enabled } = await chrome.storage.local.get({ enabled: true });
    await chrome.action.setBadgeText({ text: enabled === false ? 'OFF' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#666666' });
  } catch (e) {
    console.warn(TAG, 'falha ao atualizar o selo', e);
  }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) updateBadge();
});
chrome.runtime.onStartup.addListener(updateBadge);
chrome.runtime.onInstalled.addListener(updateBadge);

// ---------- Corte automático: conversa com o painel ----------

const PAINEL_PADRAO = 'http://127.0.0.1:3210';
const API = '/api/auto-clip/extensao';
const ID_RE = /^(yt:[A-Za-z0-9_-]{6,20}|tw:[a-z0-9_]{2,25}|kick:[a-z0-9_-]{2,40})$/;
const PAINEL_CACHE_MS = 8000;
const PAINEL_TIMEOUT_MS = 4000;
const POST_MIN_MS = 8000;
const ABA_VELHA_MS = 35_000; // aba sem sinal há mais que isso sai da lista
const ABRIR_INTERVALO_MS = 5 * 60_000; // abre a mesma live no máximo 1 vez a cada 5 min
const MAX_ABAS = 6;
const ALARME = 'auto-clip';

const abas = new Map(); // tabId -> { aba, em }
let painel = { em: 0, ok: null, erro: null, url: PAINEL_PADRAO, max: 1, ativos: [] };
let painelBusca = null;
let ultimoPost = 0;

// Endereço do painel: chrome.storage.local "painelUrl" (para teste em outra porta), só 127.0.0.1.
async function painelUrl() {
  try {
    const { painelUrl: u } = await chrome.storage.local.get({ painelUrl: PAINEL_PADRAO });
    const limpo = typeof u === 'string' ? u.replace(/\/+$/, '') : '';
    if (/^http:\/\/127\.0\.0\.1(:\d{1,5})?$/.test(limpo)) return limpo;
  } catch (e) { /* usa o padrão */ }
  return PAINEL_PADRAO;
}

// Id da live pelo endereço da aba (mesma regra do content script, contrato item 1).
const TWITCH_RESERVED = new Set(['directory', 'videos', 'settings', 'search', 'p', 'u', 'popout',
  'downloads', 'subscriptions', 'inventory', 'wallet', 'drops', 'turbo', 'prime', 'friends',
  'messages', 'moderator', 'following', 'login', 'signup', 'jobs', 'store', 'broadcast']);
const KICK_RESERVED = new Set(['browse', 'categories', 'category', 'following', 'search', 'video',
  'videos', 'clips', 'settings', 'dashboard', 'events', 'subscriptions', 'login', 'signup',
  'terms-of-service', 'privacy-policy', 'community-guidelines', 'dmca-policy', 'popout', 'help']);

function idFromUrl(raw) {
  let u;
  try { u = new URL(raw); } catch (e) { return ''; }
  if (u.protocol !== 'https:') return '';
  let id = '';
  const seg = (u.pathname.match(/^\/([^/]+)\/?$/) || [])[1];
  if (u.hostname === 'www.youtube.com') {
    if (u.pathname === '/watch') id = 'yt:' + (u.searchParams.get('v') || '');
    else if (u.pathname.startsWith('/live/')) id = 'yt:' + u.pathname.slice(6).split('/')[0];
  } else if (u.hostname === 'www.twitch.tv' && seg && !TWITCH_RESERVED.has(seg.toLowerCase())) {
    id = 'tw:' + seg.toLowerCase();
  } else if (u.hostname === 'kick.com' && seg && !KICK_RESERVED.has(seg.toLowerCase())) {
    id = 'kick:' + seg.toLowerCase();
  }
  return ID_RE.test(id) ? id : '';
}

// Endereço de live que dá para abrir: https num dos 3 sites.
function urlAbrivel(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && ['www.youtube.com', 'www.twitch.tv', 'kick.com'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

// GET /api/auto-clip/extensao com cache de ~8 s. Painel fora do ar: ok=false e nenhuma live ativa.
async function getPainel(force = false) {
  if (!force && Date.now() - painel.em < PAINEL_CACHE_MS) return painel;
  if (painelBusca) return painelBusca;
  painelBusca = (async () => {
    const url = await painelUrl();
    try {
      const r = await fetch(url + API, { cache: 'no-store', signal: AbortSignal.timeout(PAINEL_TIMEOUT_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j || j.ok !== true || !Array.isArray(j.ativos)) throw new Error('resposta inesperada');
      const ativos = j.ativos
        .filter((a) => a && typeof a.id === 'string' && ID_RE.test(a.id))
        .map((a) => ({
          id: a.id,
          url: typeof a.url === 'string' ? a.url : '',
          canal: typeof a.canal === 'string' ? a.canal : '',
        }));
      painel = { em: Date.now(), ok: true, erro: null, url, max: Number(j.max) || 1, ativos };
    } catch (e) {
      if (painel.ok !== false) console.warn(TAG, 'painel fora do ar', url, String(e && e.message || e));
      painel = { em: Date.now(), ok: false, erro: 'Painel fora do ar', url, max: 1, ativos: [] };
    }
    return painel;
  })();
  try {
    return await painelBusca;
  } finally {
    painelBusca = null;
  }
}

function podarAbas() {
  const agora = Date.now();
  for (const [tabId, v] of abas) if (agora - v.em > ABA_VELHA_MS) abas.delete(tabId);
}

// POST /api/auto-clip/extensao com o estado das abas (no máximo 1 a cada ~8 s).
async function postStatus(force = false) {
  if (!force && Date.now() - ultimoPost < POST_MIN_MS) return;
  ultimoPost = Date.now();
  const p = await getPainel();
  if (!p.ok) return;
  podarAbas();
  const lista = [...abas.values()].map((v) => v.aba).slice(0, MAX_ABAS);
  try {
    const r = await fetch(p.url + API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ versao: chrome.runtime.getManifest().version, abas: lista }),
      signal: AbortSignal.timeout(PAINEL_TIMEOUT_MS),
    });
    if (!r.ok) console.warn(TAG, 'painel recusou o status: HTTP', r.status);
  } catch (e) {
    console.warn(TAG, 'falha ao mandar o status ao painel', String(e && e.message || e));
  }
}

// Live ativa no painel sem aba aberta: abre (no máximo 1 vez a cada 5 min por id).
// Uma rodada por vez (a aba recém-criada ainda não aparece na consulta seguinte).
let abrindo = null;
function abrirFaltando() {
  if (!abrindo) abrindo = abrirFaltandoAgora().finally(() => { abrindo = null; });
  return abrindo;
}

async function abrirFaltandoAgora() {
  const p = await getPainel();
  if (!p.ok || !p.ativos.length) return;
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: SITE_PATTERNS }); } catch (e) { return; }
  const abertos = new Set();
  for (const t of tabs) {
    const id = idFromUrl(t.pendingUrl || t.url || '');
    if (id) abertos.add(id);
  }
  for (const v of abas.values()) if (v.aba && v.aba.id) abertos.add(v.aba.id);
  const { abertasEm = {} } = await chrome.storage.session.get('abertasEm').catch(() => ({}));
  for (const a of p.ativos) {
    if (abertos.has(a.id) || !urlAbrivel(a.url) || idFromUrl(a.url) !== a.id) continue;
    if (Date.now() - (abertasEm[a.id] || 0) < ABRIR_INTERVALO_MS) continue;
    // Grava antes de abrir: se algo der errado no meio, não abre de novo em seguida.
    abertasEm[a.id] = Date.now();
    await chrome.storage.session.set({ abertasEm }).catch(() => {});
    try {
      // Aba na frente: o navegador não começa o vídeo de uma aba que nunca apareceu.
      await chrome.tabs.create({ url: a.url, active: true });
      console.log(TAG, 'abrindo a live ativa no painel', a.id, a.url);
    } catch (e) {
      console.warn(TAG, 'não deu para abrir a live', a.id, e);
    }
  }
}

// Disparos do corte automático por live na última hora (o limite de 12 por hora não zera com F5).
async function disparosDe(id) {
  const { disparos = {} } = await chrome.storage.session.get('disparos').catch(() => ({}));
  const agora = Date.now();
  return (Array.isArray(disparos[id]) ? disparos[id] : []).filter((t) => agora - t < 3600_000);
}

async function registrarDisparo(id, em) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false };
  const { disparos = {} } = await chrome.storage.session.get('disparos').catch(() => ({}));
  const agora = Date.now();
  for (const k of Object.keys(disparos)) {
    disparos[k] = (Array.isArray(disparos[k]) ? disparos[k] : []).filter((t) => agora - t < 3600_000);
    if (!disparos[k].length) delete disparos[k];
  }
  const t = typeof em === 'number' && Math.abs(agora - em) < 600_000 ? em : agora;
  disparos[id] = [...(disparos[id] || []), t].slice(-50);
  await chrome.storage.session.set({ disparos }).catch(() => {});
  return { ok: true, disparos: disparos[id] };
}

// Aba escondida e sem som há mais de 4 min: o navegador segura os timers e o corte pode atrasar.
const ESCONDIDA_SEM_SOM_MS = 4 * 60_000;
const escondidaDesde = new Map(); // tabId -> instante

// Sinal de uma aba (a cada ~10 s): guarda o status e responde se a live dela está ativa.
async function onTabStatus(tab, aba) {
  if (!aba || typeof aba !== 'object' || typeof aba.id !== 'string' || !ID_RE.test(aba.id)) {
    if (abas.delete(tab.id)) postStatus(true).catch(() => {});
    return { ativo: false };
  }
  const p = await getPainel();
  const ativo = !!p.ok && p.ativos.some((a) => a.id === aba.id);
  const semSom = !tab.audible || (tab.mutedInfo && tab.mutedInfo.muted);
  if (aba.oculta && semSom) {
    if (!escondidaDesde.has(tab.id)) escondidaDesde.set(tab.id, Date.now());
  } else {
    escondidaDesde.delete(tab.id);
  }
  const status = { ...aba, ativo };
  if (!status.erro && escondidaDesde.has(tab.id) && Date.now() - escondidaDesde.get(tab.id) > ESCONDIDA_SEM_SOM_MS) {
    status.erro = 'aba escondida e sem som: o navegador pode atrasar o corte';
  }
  // O status vai com o "ativo" que o painel acabou de dizer.
  abas.set(tab.id, { aba: status, em: Date.now() });
  postStatus().catch(() => {});
  abrirFaltando().catch(() => {});
  return { ativo, painel: p.ok, erro: p.erro, disparos: await disparosDe(aba.id) };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  escondidaDesde.delete(tabId);
  if (abas.delete(tabId)) postStatus(true).catch(() => {});
});

// Reserva: a cada 30 s confere o painel mesmo sem aba de live mandando sinal.
async function garantirAlarme() {
  try {
    if (!(await chrome.alarms.get(ALARME))) await chrome.alarms.create(ALARME, { periodInMinutes: 0.5 });
  } catch (e) {
    console.warn(TAG, 'falha ao criar o alarme', e);
  }
}
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARME) return;
  await getPainel(true);
  podarAbas();
  await postStatus(true).catch(() => {});
  await abrirFaltando().catch(() => {});
});
chrome.runtime.onInstalled.addListener(garantirAlarme);
chrome.runtime.onStartup.addListener(garantirAlarme);
garantirAlarme();
