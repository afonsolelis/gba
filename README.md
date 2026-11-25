# GBA

Emulador de Game Boy Advance (e GB/GBC, Nintendo 64 e Nintendo DS) no navegador, pensado para o celular, com
login por PIN e saves sincronizados num bucket S3 (RustFS) na VPS.

- **Site:** https://gba.afonsolelis.tech — `docs/` servido por nginx na VPS (serviço `site` do mesmo
  compose, config em `api/nginx.conf`, imagem `api/Dockerfile.site`). O GitHub Pages foi despublicado em
  11/11: o Actions dava `startup_failure` interno e o github.io ficou preso numa versão velha.
  Para religar: Settings → Pages → Source "GitHub Actions" e `gh workflow enable pages.yml`.
- **API:** https://gba-api.afonsolelis.tech — `api/server.mjs`, Node 22 sem dependências, no Coolify (projeto `gba`).
- **Lake:** bucket `gba` no RustFS (`s3.afonsolelis.tech`), usuário `gba-app` com acesso só a esse bucket.

Este repositório não tem ROM, save nem segredo: tudo isso fica no bucket, atrás do login.

## Como funciona

```
celular / navegador ──(PIN → token Bearer)──► gba-api ──(SigV4)──► RustFS: bucket gba
        │                                                              roms/<id>.gba|gb|gbc|z64|n64|v64|nds
        └─ EmulatorJS 4.2.3 (mGBA / mupen64plus_next, CDN)             saves/<id>.sav
                                                                       saves-history/<id>/<data>.sav
                                                                       states/<id>.state + .png
```

- **Save do jogo (SRAM):** ao abrir, o site baixa `saves/<id>.sav` e carrega no emulador; enquanto
  você joga, envia a cada 10 s (só quando muda), ao trocar de app e ao voltar para a biblioteca.
  A API guarda uma cópia em `saves-history/` no máximo a cada 15 min.
  Se não conseguir ler o save do lake, o site não envia nada (para não sobrescrever o progresso).
- **Savestate:** os botões de salvar/carregar estado do EmulatorJS gravam no lake (um por jogo) e o
  print da tela vira a capa do jogo na biblioteca.
- **Velocidade:** botão `1x…5x → 10x` na barra do jogo (ou teclas 1–9, e 0 = 10x). Usa o fast-forward do EmulatorJS,
  então o botão "Rápido" do gamepad virtual segue a mesma velocidade.
- **Multiplicador de EXP:** seletor `EXP 1x/10x/100x/1000x` na barra, nos Pokémon de GBA (Ruby,
  Sapphire, Emerald, FireRed, LeafGreen) e de GB/GBC (Red, Blue, Yellow, Gold, Silver, Crystal 1.1).
  É um patch na ROM aplicado na memória ao abrir (a ROM do lake não muda), só quando os bytes
  originais conferem; a escolha fica no navegador. Gerados e testados por `tools/exp_patch.py` (GBA,
  Unicorn) e `tools/exp_patch_gb.py` (GB/GBC, PyBoy). Green (japonês) não tem.
  Nos de DS (Diamond a White 2, versões US) é um código de Action Replay passado ao emulador
  (`EJS_cheats`), da libretro-database: x2/x8/x64/x1024 (Black 2/White 2: x2/x10/x100/x200).
- **Controles (teclado):** A = `Z`, B = `X`, L = `Q`, R = `E`, Start = `Enter`, Select = `V`, setas = direcional;
  `1`–`5` = velocidade. Os atalhos 1/2/3 do EmulatorJS (quick save/load/slot) foram desligados: gravavam
  só no navegador e brigavam com a velocidade. Dá para remapear no ícone de controle da barra do emulador
  (vale por jogo, fica no navegador). Controle Bluetooth/USB funciona direto.
- **Celular:** o EmulatorJS mostra os botões na tela sozinho em aparelhos touch. Dá para
  "Adicionar à tela inicial" e abrir em tela cheia (manifest PWA).
- **Nintendo 64:** ROMs `.z64`/`.n64`/`.v64` usam o núcleo `n64` (mupen64plus_next) e vão para a
  prateleira "Nintendo 64". Teclado: analógico = setas, A = `Z`, B = `X`, Z (gatilho) = `Shift`,
  L = `Q`, R = `E`, Start = `Enter`, botões C = `I`/`J`/`K`/`L`, direcional = `T`/`F`/`G`/`H`.
  Savestate de N64 é grande (vários MB; o limite da API é 48 MB).
- **Nintendo DS:** ROMs `.nds` rodam no núcleo `desmume2015` (DeSmuME) e vão para a prateleira
  "Nintendo DS" (os Pokémon, para "Pokémon · Nintendo DS"). Não é o melonDS porque ele roda cheat
  uma vez só, e o multiplicador de EXP precisa ser reaplicado a cada quadro. Não troque de núcleo
  depois de ter save: o formato não é garantido entre os dois. As telas ficam lado a lado
  (`desmume_screens_layout: left/right`; troca em Ajustes → Backend Core Options → "desmume screens
  layout"); a de toque responde ao mouse/dedo. Teclado: A = `Z`, B = `X`, X = `A`, Y = `S`, L = `Q`,
  R = `E`. ROMs de DS passam de 100 MB e o `PUT /rom` da API junta tudo na memória (container de
  128 MB): suba as grandes direto no bucket (`roms/<id>.nds`), não pelo `+ ROM`.
- **ROMs novas:** botão `+ ROM` na biblioteca (vai para `roms/`). Aceita `.zip`: o site descompacta
  no navegador e envia a primeira ROM de dentro. A ROM fica em cache no navegador
  depois do primeiro download.

## Login

PIN de 6 dígitos. A API guarda só o hash scrypt (`PIN_SCRYPT`) e devolve um token de sessão
assinado (HMAC, 30 dias), que o site guarda no `localStorage` e manda em `Authorization: Bearer`.
Não é cookie porque o site (github.io) e a API (afonsolelis.tech) são sites diferentes e os
navegadores bloqueiam cookie entre eles. "Sair" apaga o token do aparelho; para derrubar todas as
sessões, troque `SESSION_SECRET` no Coolify. A API só aceita pedidos de navegador vindos de
`https://gba.afonsolelis.tech` e `https://afonsolelis.github.io` (`ALLOWED_ORIGINS`). Contra força bruta: 5 erros por IP
bloqueiam o IP por 15 min; 20 erros em 1 h fecham o login para todos por 1 h.

Trocar o PIN:

```sh
node -e 'const c=require("crypto"),s=c.randomBytes(16);console.log(s.toString("hex")+":"+c.scryptSync(process.argv[1],s,32).toString("hex"))' NOVOPIN
```

e colocar o resultado em `PIN_SCRYPT` no serviço do Coolify (e em `GBA_PIN_SCRYPT` no `.env` da hostinger).

## Desenvolvimento

```sh
# API (lê GBA_* de ~/repos/hostinger/.env)
set -a; . ~/repos/hostinger/.env; set +a
S3_ACCESS_KEY=$GBA_S3_ACCESS_KEY S3_SECRET_KEY=$GBA_S3_SECRET_KEY PIN_SCRYPT=$GBA_PIN_SCRYPT \
SESSION_SECRET=$GBA_SESSION_SECRET ALLOWED_ORIGINS=http://localhost:8000 PORT=8787 node api/server.mjs

# site (em localhost o front usa a API em :8787)
python3 -m http.server 8000 -d docs
```

Deploy: `git push` na main. O GitHub Actions (`.github/workflows/ci.yml`) roda sintaxe, hadolint, gitleaks, build das imagens `gba-api` e `gba-site`, smoke test e trivy, publica no GHCR e manda o Coolify trocar a versão pela API (`api/coolify-deploy.sh`, compose em `api/docker-compose.yml`). Sem SSH.
O compose do serviço está em `api/docker-compose.yml`.
