// Copia o bundle do Mediabunny e a licença para lib/ (rodar depois de atualizar o pacote).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = path.join(root, 'node_modules', 'mediabunny');
const lib = path.join(root, 'lib');
fs.mkdirSync(lib, { recursive: true });
fs.copyFileSync(path.join(pkg, 'dist', 'bundles', 'mediabunny.min.cjs'), path.join(lib, 'mediabunny.min.cjs'));
fs.copyFileSync(path.join(pkg, 'LICENSE'), path.join(lib, 'MEDIABUNNY-LICENSE'));
const version = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version;
console.log(`Mediabunny ${version} copiado para lib/`);
