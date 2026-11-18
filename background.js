/*
 * Clip Live: service worker.
 * Faz o download na subpasta clip-live/ e repassa os atalhos para a aba ativa.
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

// Só aceita pedido de download vindo desta extensão, com blob do YouTube e nome esperado.
function validDownload(msg, sender) {
  return sender.id === chrome.runtime.id
    && typeof msg.url === 'string' && msg.url.startsWith('blob:https://www.youtube.com/')
    && typeof msg.filename === 'string' && msg.filename.startsWith('clip-live/')
    && msg.filename.endsWith('.mp4') && !msg.filename.includes('..');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'download') {
    if (!validDownload(msg, sender)) {
      sendResponse({ ok: false, error: 'pedido de download recusado' });
      return false;
    }
    handleDownload(msg).then(sendResponse);
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
    // Aba sem o content script (não é YouTube): nada a fazer.
    console.warn(TAG, 'atalho sem aba do YouTube', e);
  }
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'clip-30') sendClip(30, tab);
  else if (command === 'clip-60') sendClip(60, tab);
});

// Ao instalar ou recarregar a extensão, o navegador não coloca o content script
// nas abas que já estavam abertas. Injeta nas abas do YouTube abertas para não precisar de F5.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['lib/mediabunny.min.cjs', 'mux.js', 'content.js'],
        });
        console.log(TAG, 'injetado na aba aberta', tab.id);
      } catch (e) {
        console.warn(TAG, 'não deu para injetar na aba', tab.id, e);
      }
    }
  } catch (e) {
    console.warn(TAG, 'falha ao listar abas do YouTube', e);
  }
});
