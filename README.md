# Clip Live

Extensão para Vivaldi/Chrome (Manifest V3) que funciona como "replay buffer" de lives do YouTube. Enquanto a live toca, ela codifica o vídeo do player em segundo plano e guarda só os últimos ~70 segundos. Num clique, salva um MP4 com os últimos 30 segundos ou 1 minuto.

Tudo acontece no próprio navegador (WebCodecs + [Mediabunny](https://mediabunny.dev) para montar o MP4). Nada é enviado para fora.

## Instalar no Vivaldi

1. Abra `vivaldi://extensions`.
2. Ligue o **Modo de desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `H:\Projetos\clip-live`.
4. Recarregue as abas do YouTube que já estavam abertas.

No Chrome é igual, em `chrome://extensions`.

## Ligar e desligar
No popup (ícone da extensão) tem a chave **Ligada / Desligada**. Desligada, a extensão não grava nem usa o processador, os botões somem do player e o ícone mostra "OFF". Vale para todas as abas na hora.

## Como usar

1. Abra uma live do YouTube e deixe tocando. Quando a gravação começa, aparecem no player um pontinho vermelho e os botões **30s** e **1min** (com tesoura), ao lado das configurações.
2. Aconteceu algo bom? Clique em **30s** ou **1min**. Aparece "Montando clipe..." e depois "Clipe de 30s salvo".
3. O arquivo vai para `Downloads\clip-live\` com o nome `canal_AAAA-MM-DD_HHhMMmSSs_30s.mp4`.

O ícone da extensão abre um painel com o estado da aba ("Gravando: 47s no buffer, 1280x720"), os mesmos dois botões e a lista de atalhos.

## Atalhos

- `Alt+Shift+1`: clipar os últimos 30s
- `Alt+Shift+2`: clipar o último 1min

Para mudar: no painel da extensão, clique em **Mudar atalhos** (abre `chrome://extensions/shortcuts`). Se o atalho aparecer vazio, é porque outra extensão ou o Vivaldi já usava a combinação: escolha outra lá.

## Limites

- Só grava o que passou com a aba aberta e a live tocando. Não dá para voltar além disso.
- A resolução do clipe é fixada no primeiro frame da live (fora do anúncio), limitada a 1920 no maior lado. Se depois a qualidade do player mudar, os frames são redimensionados para esse tamanho e nada se perde. Para clipe em 1080p, deixe o player em 1080p **antes** de abrir a live (ou recarregue a página depois de trocar).
- Só uma mudança de proporção (por exemplo, a live virar vertical) recomeça o buffer. Nesse caso o clipe logo depois pode sair mais curto (o aviso mostra a duração real).
- Anúncios, pausas e travadas não entram no clipe: o buraco é "comprimido". Um clipe de 1min tem 1min de live de verdade, mesmo que no meio tenha passado um anúncio.
- A gravação continua com a aba em segundo plano, mas o navegador pode congelar o vídeo de uma aba escondida, e aí não chega nada para gravar. Deixe a live visível, ou numa janela separada. O painel da extensão avisa quando isso acontece.
- Grave uma live por vez. A placa de vídeo tem um número limitado de sessões de codificação por hardware; com várias lives abertas gravando, as que sobrarem caem para codificação por software (mais CPU) ou falham.
- Usa memória (uns 50 a 80 MB por aba gravando em 1080p) e um pouco de CPU/GPU para codificar.
- Se o download pela subpasta falhar, o clipe vai direto para a pasta Downloads (sem a subpasta `clip-live`).

## Problemas

Abra o console da página do YouTube (F12) e filtre por `[clip-live]`: lá aparecem a resolução gravada, os codecs escolhidos, os timestamps iniciais e qual caminho de download funcionou. A cada 10 s sai uma linha `[clip-live] diag` com os contadores: frames que chegaram (`framesIn`), descartados por anúncio, pausa, fila ou repetição, e o mesmo para o áudio (`audioIn`, `audioInSec`, `audioOutSec`, `audioDrop...`, `audioLagMs`). Se `audioOutSec` ficar bem menor que o tempo gravado, o áudio está se perdendo.

## Atualizar a biblioteca (Mediabunny)

```
npm install mediabunny@latest
npm run vendor
```

O `vendor` copia `mediabunny.min.cjs` (com o nome `mediabunny.min.js`, porque o navegador só aceita .js em content script) e a licença (MPL-2.0) para `lib/`. Depois, recarregue a extensão em `vivaldi://extensions`.

Para conferir a montagem do MP4 sem navegador (precisa de `ffmpeg` e `ffprobe` no PATH):

```
npm test
```

## Arquivos

- `manifest.json`: configuração da extensão.
- `content.js`: detecção da live, captura, codificação, buffer, botões e toast.
- `mux.js`: monta o MP4 com o Mediabunny.
- `background.js`: download na subpasta e atalhos.
- `popup.html`, `popup.js`, `popup.css`: painel do ícone.
- `lib/`: Mediabunny vendorizado (MPL-2.0, licença em `lib/MEDIABUNNY-LICENSE`).
- `tools/`: gerador de ícones (`gerar-icones.ps1`), cópia da lib (`vendor.js`) e teste do mux (`test-mux.js`).
