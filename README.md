# Clip Live

Extensão para Vivaldi/Chrome (Manifest V3) que funciona como "replay buffer" de lives do YouTube, da Twitch e da Kick. Enquanto a live toca, ela codifica o vídeo do player em segundo plano e guarda só os últimos ~70 segundos. Num clique, salva um MP4 com os últimos 30 segundos ou 1 minuto.

Tudo acontece no próprio navegador (WebCodecs + [Mediabunny](https://mediabunny.dev) para montar o MP4). Nada é enviado para fora.

## Instalar no Vivaldi

1. Abra `vivaldi://extensions`.
2. Ligue o **Modo de desenvolvedor** (canto superior direito).
3. Clique em **Carregar sem compactação** e escolha a pasta `H:\Projetos\clip-live`.
4. Recarregue as abas de live (YouTube, Twitch, Kick) que já estavam abertas.

No Chrome é igual, em `chrome://extensions`.

## Ligar e desligar
No popup (ícone da extensão) tem a chave **Ligada / Desligada**. Desligada, a extensão não grava nem usa o processador, os botões somem do player e o ícone mostra "OFF". Vale para todas as abas na hora.

## Como usar

1. Abra uma live do YouTube, da Twitch (`twitch.tv/<canal>`) ou da Kick (`kick.com/<canal>`) e deixe tocando. Quando a gravação começa, aparecem no player um pontinho vermelho e os botões **30s** e **1min** (com tesoura): no YouTube ao lado das configurações, na Twitch e na Kick no canto de cima, à direita.
2. Aconteceu algo bom? Clique em **30s** ou **1min**. Aparece "Montando clipe..." e depois "Clipe de 30s salvo".
3. O arquivo vai para `Downloads\clip-live\` com o nome `canal_AAAA-MM-DD_HHhMMmSSs_30s.mp4`. Antes dele sai um `.json` com o mesmo nome (endereço da live, título, canal, plataforma, hora), que o `cortes.py` lê.

O ícone da extensão abre um painel com o estado da aba ("Gravando: 47s no buffer, 1280x720"), os mesmos dois botões e a lista de atalhos.

## Corte automático pelo chat

Quando a live da aba está **ativa no painel** (Pérola Painel, aba "Corte automático"), a extensão lê o chat e corta sozinha quando muita gente ri ao mesmo tempo. O chat só é lido com a live ativa (economiza processador).

- Conta como risada: `kkk`, `haha`, `hehehe`, `huehue`, `rsrs`, `ksks`, `kaka`, `lmao`, `lul`, `kekw`, `omegalul`, `icant`, 😂 🤣 💀 e `!clip`. O nome de quem escreveu não conta, e cada pessoa conta no máximo 1 risada a cada 10 s (uma pessoa sozinha não faz pico). Um lote grande de mensagens que chega de uma vez (chat pausado que voltou, chat rolado para cima, aba que voltou a aparecer) fica fora da contagem, e nada conta enquanto a Twitch mostra o aviso de chat pausado.
- Pico: risadas nos últimos 10 s contra o normal (média por janela de 10 s nos últimos 5 min, sem os últimos 20 s). Dispara com pelo menos `max(6, 3 x normal + 2)` risadas e se elas forem pelo menos 25% das mensagens dos 10 s.
- Antes de poder disparar, lê o chat por 2 min depois de ativar (aquecimento).
- Disparou: espera 30 s e salva 1 min (30 s antes e 30 s depois do pico), com o nome `..._60s_auto.mp4` e o `.json` com o motivo ("14 risadas em 10 s (o normal é 2)"). Pausa de 2 min entre disparos e no máximo 12 por hora por live (F5 não zera a conta). Se a aba mudar de live antes de salvar (raid, outro canal), o corte pendente é descartado. Com corte pendente, a gravação não troca de resolução.
- Nos controles do player aparece o selo **AUTO** quando a aba está ativa no painel.
- Liga e desliga só pelo painel. A extensão consulta `GET http://127.0.0.1:3210/api/auto-clip/extensao` (a cada ~10 s com live aberta e a cada 30 s de reserva) e manda o estado das abas no `POST` da mesma rota. Live ativa sem aba aberta: a extensão abre a live (no máximo 1 vez a cada 5 min).
- Aba escondida e sem som por mais de 4 min: o navegador segura os timers e o corte pode atrasar; o painel mostra o aviso "aba escondida e sem som".
- Painel fora do ar: nada quebra, o corte automático fica parado e o popup avisa.
- Os números ficam no topo do `content.js` (`AUTO_DEFAULTS`). Para testar, dá para baixar por `chrome.storage.local` `autoClipDebug` (ex.: `{"minimo": 2, "aquecimento_s": 30}`), desligado por padrão. O endereço do painel pode ir para outra porta por `chrome.storage.local` `painelUrl` (só `http://127.0.0.1:<porta>`).

## Atalhos

- `Alt+Shift+1`: clipar os últimos 30s
- `Alt+Shift+2`: clipar o último 1min

Para mudar: no painel da extensão, clique em **Mudar atalhos** (abre `chrome://extensions/shortcuts`). Se o atalho aparecer vazio, é porque outra extensão ou o Vivaldi já usava a combinação: escolha outra lá.

## Limites

- Só grava o que passou com a aba aberta e a live tocando. Não dá para voltar além disso.
- A resolução do clipe segue o primeiro frame da live (fora do anúncio), limitada a 1920 no maior lado. Se a qualidade do player cair, os frames são redimensionados para esse tamanho e nada se perde. Se a qualidade subir (imagem mais de 20% maior, mesma proporção), a gravação passa para o tamanho novo: só para cima e no máximo 1 troca a cada 10 s.
- Mudança de proporção (por exemplo, a live virar vertical) ou subida de qualidade recomeça o buffer. Nesse caso o clipe logo depois pode sair mais curto e o aviso diz "o formato do vídeo mudou".
- Anúncios, pausas e travadas não entram no clipe: o buraco é "comprimido". Um clipe de 1min tem 1min de live de verdade, mesmo que no meio tenha passado um anúncio.
- A gravação continua com a aba em segundo plano, mas o navegador pode congelar o vídeo de uma aba escondida, e aí não chega nada para gravar. Deixe a live visível, ou numa janela separada. O painel da extensão avisa quando isso acontece.
- Twitch: live com aviso de conteúdo (jogo para maiores, como GTA VI) só toca com a conta logada no navegador.
- Twitch e Kick começam na qualidade automática baixa e sobem depois: nos primeiros segundos o clipe pode sair menor ou mais curto (veja acima). Na Twitch, a extensão já pede a qualidade "Fonte" ao abrir a live, só se você nunca escolheu uma qualidade lá.
- Grave uma live por vez. A placa de vídeo tem um número limitado de sessões de codificação por hardware; com várias lives abertas gravando, as que sobrarem caem para codificação por software (mais CPU) ou falham.
- Usa memória (uns 50 a 80 MB por aba gravando em 1080p) e um pouco de CPU/GPU para codificar.
- Se o download pela subpasta falhar, o clipe vai direto para a pasta Downloads (sem a subpasta `clip-live`).

## Problemas

Abra o console da página da live (F12) e filtre por `[clip-live]`: lá aparecem a resolução gravada, os codecs escolhidos, os timestamps iniciais e qual caminho de download funcionou. A cada 10 s sai uma linha `[clip-live] diag` com os contadores: frames que chegaram (`framesIn`), descartados por anúncio, pausa, fila ou repetição, e o mesmo para o áudio (`audioIn`, `audioInSec`, `audioOutSec`, `audioDrop...`, `audioLagMs`). Se `audioOutSec` ficar bem menor que o tempo gravado, o áudio está se perdendo.

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
- `twitch-quality.js`: pede a qualidade "Fonte" na Twitch antes de o player carregar.
- `content.js`: detecção da live por site (YouTube, Twitch, Kick), captura, codificação, buffer, botões, toast e leitura do chat (corte automático).
- `mux.js`: monta o MP4 com o Mediabunny.
- `background.js`: download na subpasta, atalhos e conversa com o painel (corte automático).
- `popup.html`, `popup.js`, `popup.css`: painel do ícone.
- `lib/`: Mediabunny vendorizado (MPL-2.0, licença em `lib/MEDIABUNNY-LICENSE`).
- `tools/`: gerador de ícones (`gerar-icones.ps1`), cópia da lib (`vendor.js`) e teste do mux (`test-mux.js`).
