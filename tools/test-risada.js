/*
 * Teste da regex de risada (LAUGH_RE) do content.js, em Node.
 * Lê a regex direto do content.js (sem copiar), e testa como o content.js testa: em text.toLowerCase().
 * Uso: node tools/test-risada.js   (ou npm test)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
const m = src.match(/^\s*const LAUGH_RE = (\/.+\/[a-z]*);\s*$/m);
if (!m) {
  console.log('FALHOU: não achei "const LAUGH_RE = /.../" no content.js');
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const LAUGH_RE = new Function(`return ${m[1]};`)();
const isLaugh = (text) => LAUGH_RE.test(text.toLowerCase());

const risadas = [
  // português (já contavam antes)
  'kkkkk', 'KKKK', 'hahaha', 'hehehe', 'huehue', 'rsrs', 'ksksks', 'kakaka',
  'lmao', 'lul', 'KEKW', 'omegalul', 'icant', '😂', '🤣', '💀', '!clip',
  // inglês e emotes novos
  'lol', 'LOL', 'lol!!!', ' lol ', 'lool', 'LOOOOL', 'loll', 'lolll', 'lollol', 'LOLLOLLOL', 'lol lol',
  'that was looool', 'bro lolll',
  'lmao', 'lmaooo', 'LMAOOOOO', 'lmaaaao', 'lmfao', 'LMFAOOO', 'rofl', 'ROFL!!',
  'xd', 'XD', 'xddd', 'XDDDD', 'xxd', 'ok xd', 'jajaja', 'JAJAJAJA',
  'KEKL', 'LULW', 'PepeLaugh', 'pepelaugh pepelaugh', '😆', '😹', 'bro 😆',
];
const normais = [
  // falso positivo comum em português
  'jaja volto', 'ja ja', 'já já', 'loja', 'lola', 'lolita', 'alô', 'bolo', 'colocou',
  'xdd5', 'axd', 'xdx', 'pxd', 'maxdome', 'xdes', 'lmaozinho', 'roflmao2', 'xadrez',
  'beleza', 'boa noite chat', 'que jogada', 'GG', 'lulu', 'kek', 'pepe', 'cant stop',
  'hello', 'old', 'local', 'follow', 'control', 'lolzinho',
  // "lol" no meio da frase é o jogo (League of Legends)
  'bora de lol', 'jogar lol', 'lol hoje?', 'quem joga lol', 'lol that was insane', 'that is so funny lol',
];

let falhas = 0;
for (const t of risadas) {
  if (!isLaugh(t)) { falhas++; console.log('  FALHOU (devia contar):', JSON.stringify(t)); }
}
for (const t of normais) {
  if (isLaugh(t)) { falhas++; console.log('  FALHOU (não devia contar):', JSON.stringify(t)); }
}
const total = risadas.length + normais.length;
console.log(`risada: ${total - falhas}/${total} casos ok (${risadas.length} risadas, ${normais.length} mensagens normais)`);
process.exit(falhas ? 1 : 0);
