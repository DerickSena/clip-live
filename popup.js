'use strict';

const $ = (id) => document.getElementById(id);
let tabId = null;
let busy = false;
let lastFramesIn = null;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshStatus() {
  const el = $('status');
  try {
    const st = await chrome.tabs.sendMessage(tabId, { type: 'status' });
    if (st && st.error) {
      el.textContent = st.error;
      el.className = 'status';
      setButtons(false);
    } else if (st && st.recording) {
      // framesIn parado entre duas consultas com a aba escondida = vídeo congelado.
      const stalled = lastFramesIn !== null && st.framesIn === lastFramesIn;
      lastFramesIn = st.framesIn;
      const res = st.width ? `, ${st.width}x${st.height}` : '';
      if (st.adShowing) el.textContent = `Esperando o anúncio acabar (${st.seconds}s no buffer)`;
      else if (st.hidden && stalled) el.textContent = 'Aba em segundo plano: o navegador pode pausar o vídeo';
      else el.textContent = `Gravando: ${st.seconds}s no buffer${res}`;
      el.className = 'status rec';
      setButtons(st.chunksVideo > 0);
    } else {
      el.textContent = 'Abra uma live do YouTube';
      el.className = 'status';
      setButtons(false);
    }
  } catch (e) {
    el.textContent = 'Abra uma live do YouTube';
    el.className = 'status';
    setButtons(false);
  }
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
    out.textContent = 'Não deu: abra uma live do YouTube';
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

(async () => {
  const tab = await activeTab();
  tabId = tab ? tab.id : null;
  showShortcuts();
  if (tabId === null) return;
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
