# GBA

Emulador de Game Boy Advance (e GB/GBC) no navegador, pensado para o celular, com
login por PIN e saves sincronizados num bucket S3 (RustFS) na VPS.

- **Site:** https://gba.afonsolelis.tech — estático, publicado pelo GitHub Pages a partir de `docs/`.
- **API:** https://gba-api.afonsolelis.tech — `api/server.mjs`, Node 22 sem dependências, no Coolify (projeto `gba`).
- **Lake:** bucket `gba` no RustFS (`s3.afonsolelis.tech`), usuário `gba-app` com acesso só a esse bucket.

Este repositório não tem ROM, save nem segredo: tudo isso fica no bucket, atrás do login.

## Como funciona

```
celular / navegador ──(PIN → cookie HttpOnly)──► gba-api ──(SigV4)──► RustFS: bucket gba
        │                                                              roms/<id>.gba|gb|gbc
        └─ EmulatorJS 4.2.3 (núcleo mGBA, CDN)                         saves/<id>.sav
                                                                       saves-history/<id>/<data>.sav
                                                                       states/<id>.state + .png
```

- **Save do jogo (SRAM):** ao abrir, o site baixa `saves/<id>.sav` e carrega no emulador; enquanto
  você joga, envia a cada 10 s (só quando muda), ao trocar de app e ao voltar para a biblioteca.
  A API guarda uma cópia em `saves-history/` no máximo a cada 15 min.
  Se não conseguir ler o save do lake, o site não envia nada (para não sobrescrever o progresso).
- **Savestate:** os botões de salvar/carregar estado do EmulatorJS gravam no lake (um por jogo) e o
  print da tela vira a capa do jogo na biblioteca.
- **Velocidade:** botão `1x…5x` na barra do jogo (ou teclas 1–5). Usa o fast-forward do EmulatorJS,
  então o botão "Rápido" do gamepad virtual segue a mesma velocidade.
- **Celular:** o EmulatorJS mostra os botões na tela sozinho em aparelhos touch. Dá para
  "Adicionar à tela inicial" e abrir em tela cheia (manifest PWA).
- **ROMs novas:** botão `+ ROM` na biblioteca (vai para `roms/`). A ROM fica em cache no navegador
  depois do primeiro download.

## Login

PIN de 6 dígitos. A API guarda só o hash scrypt (`PIN_SCRYPT`) e devolve um cookie de sessão
assinado (HMAC, 30 dias, `HttpOnly; Secure; SameSite=Strict`). Contra força bruta: 5 erros por IP
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

Deploy da API: `api/deploy.sh` (copia o `server.mjs` para `/data/gba/api` na VPS e reinicia o serviço).
O compose do serviço está em `api/docker-compose.yml`.
