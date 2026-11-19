'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;
let busy = false;
let lastFramesIn = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let enabled = true;

function showEnabled() {
  $('enabled').checked = enabled;
  $('enabledLabel').textContent = enabled ? 'Ligada' : 'Desligada';
}

async function refreshStatus() {
  const el = $('status');
  if (!enabled) {
    el.textContent = 'Desligada: não está gravando nem usando o processador';
    el.className = 'status';
    showDiag(null);
    showSom(null);
    setButtons(false);
    return;
  }
  try {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'status' });
    refreshAuto(st).catch(() => {});
    showSom(st && !st.error ? st : null);
    if (st && st.error) {
      el.textContent = st.error;
      el.className = 'status';
      setButtons(false);
    } else if (st && st.recording) {
      // framesIn parado entre duas consultas com a aba escondida = vídeo congelado.
      const stalled = lastFramesIn !== null && st.framesIn === lastFramesIn;
      lastFramesIn = st.framesIn;
      const res = st.width
        ? `, encoder ${st.width}x${st.height}${st.qualidadeFonte ? ` (fonte ${st.qualidadeFonte})` : ''}`
        : '';
      if (st.adShowing) el.textContent = `Esperando o anúncio acabar (${st.seconds}s no buffer)`;
      else if (st.hidden && stalled) el.textContent = 'Aba em segundo plano: o navegador pode pausar o vídeo';
      else el.textContent = `Gravando: ${st.seconds}s no buffer${res}`;
      el.className = 'status rec';
      setButtons(st.chunksVideo > 0);
    } else {
      // A extensão está na aba, mas não achou live: mostra o porquê.
      const d = st && st.detect;
      el.textContent = d && d.page && d.page.startsWith('/') && !d.page.includes(':')
        ? 'Abra uma live do YouTube, Twitch ou Kick'
        : 'Nenhuma live detectada nesta aba (se for live, espere o anúncio acabar)';
      el.className = 'status';
      showDiag(d);
      setButtons(false);
    }
  } catch (e) {
    // Sem resposta: o content script não está nesta aba.
    refreshAuto(null).catch(() => {});
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    el.textContent = tab && /^https:\/\/(www\.youtube\.com|www\.twitch\.tv|kick\.com)\//.test(tab.url || '')
      ? 'A extensão ainda não está nesta aba: aperte F5 na live'
      : 'Abra uma live do YouTube, Twitch ou Kick';
    el.className = 'status';
    showDiag(null);
    showSom(null);
    setButtons(false);
  }
}

// Linha do som e da qualidade: vigia do áudio e aviso de qualidade (ex.: 1080p60 da Kick só com login).
function showSom(st) {
  const el = $('som');
  if (!el) return;
  if (!st || !st.recording) { el.hidden = true; return; }
  el.hidden = false;
  const partes = [];
  if (st.audioProblema) partes.push(`Som: ${st.audioProblema}`);
  else partes.push(st.audioOk ? 'Som: ok' : 'Som: esperando o áudio');
  if (st.audioReinicios) partes.push(`${st.audioReinicios} conserto(s) do som na última hora`);
  if (st.qualidadeAviso) partes.push(st.qualidadeAviso);
  el.textContent = partes.join(' · ');
  el.className = st.audioOk && !st.qualidadeAviso ? 'auto' : 'auto warn';
}

function showDiag(d) {
  const el = $('diag');
  if (!el) return;
  if (!d) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${d.site || ''} · página ${d.page} · player ${d.player ? 'sim' : 'não'} · vídeo ${d.video ? 'sim' : 'não'}`
    + ` · selo ao vivo ${d.badge}${d.extra ? ' · ' + d.extra : ''} · duração ${d.duration}`;
}

// Linha do corte automático: estado do painel e da live desta aba.
let painelInfo = null;
let painelAt = 0;

async function refreshAuto(st) {
  const el = $('auto');
  if (!el) return;
  if (Date.now() - painelAt > 5000) {
    painelAt = Date.now();
    painelInfo = await chrome.runtime.sendMessage({ type: 'painel-status' }).catch(() => null);
  }
  const a = st && st.auto;
  el.className = 'auto';
  if (painelInfo && painelInfo.ok === false) {
    el.hidden = false;
    el.className = 'auto warn';
    el.textContent = 'Painel fora do ar: o corte automático está parado';
    return;
  }
  if (!a) { el.hidden = true; return; }
  el.hidden = false;
  if (!a.ativo) {
    el.textContent = 'Corte automático: desligado para esta live (liga pelo painel)';
    return;
  }
  let txt = `Corte automático ligado · chat: ${a.chat ? `${a.msgs_10s} msgs e ${a.risadas_10s} risadas em 10 s (normal ${a.base_10s})` : 'não achei o chat'}`;
  if (a.aquecendo && a.chat) txt += ' · aquecendo';
  if (a.proximo_clipe_em) txt += ` · salvando às ${a.proximo_clipe_em.slice(11)}`;
  if (a.ultimo_clipe) txt += ` · último: ${a.ultimo_clipe.em.slice(11)} (${a.clipes_hora} na última hora)`;
  el.textContent = txt;
}

function setButtons(on) {
  $('clip30').disabled = !on || busy;
  $('clip60').disabled = !on || busy;
}

async function requestClip(seconds) {
  const out = $('result');
  out.hidden = false;
  out.textContent = 'Montando clipe...';
  busy = true;
  setButtons(false);
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'clip', seconds });
    out.textContent = res && res.ok ? res.message : `Não deu: ${res ? res.error : 'sem resposta'}`;
  } catch (e) {
    out.textContent = 'Não deu: abra uma live do YouTube, Twitch ou Kick';
  }
  busy = false;
  refreshStatus();
}

async function showShortcuts() {
  const ul = $('shortcuts');
  ul.textContent = '';
  const cmds = await chrome.commands.getAll();
  for (const c of cmds) {
    if (!c.description) continue;
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = c.description;
    const key = document.createElement('kbd');
    key.textContent = c.shortcut || 'sem atalho';
    li.append(name, key);
    ul.appendChild(li);
  }
}

$('clip30').addEventListener('click', () => requestClip(30));
$('clip60').addEventListener('click', () => requestClip(60));
$('changeShortcuts').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

$('enabled').addEventListener('change', async (e) => {
  enabled = e.target.checked;
  showEnabled();
  await chrome.storage.local.set({ enabled });
  refreshStatus();
});

(async () => {
  try {
    enabled = (await chrome.storage.local.get({ enabled: true })).enabled !== false;
  } catch (e) { enabled = true; }
  showEnabled();
  const tab = await activeTab();
  tabId = tab ? tab.id : null;
  showShortcuts();
  if (tabId === null) return;
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
