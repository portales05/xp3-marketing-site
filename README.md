# XP3 Marketing — Sitio web

Sitio web estático de [xp3.com.mx](https://xp3.com.mx) — hub digital de marketing.

## Estructura

- `index.html` — página principal (single-page)
- `content.json` — fuente única de verdad para el contenido editable. Editá este archivo para cambiar textos sin tocar HTML.
- `aviso-de-privacidad.html` — página standalone con el aviso de privacidad (LFPDPPP)
- `assets/` — logos transparentes (XP3, Artool, Hootsuite × Talkwalker)
- `api/chat.js` — referencia del handler del chat (el deploy real va en el repo `xp3-agent` en Railway)
- `robots.txt`, `llms.txt`, `sitemap.xml` — SEO + indexación de bots de IA

## Deploy

Se deploya automáticamente a Cloudflare Pages cuando se hace push a `main`.

URL temporal: `xp3-marketing.pages.dev`
URL final: `xp3.com.mx`

Para más detalles ver `DEPLOY.md`.

## Editar contenido

Editá `content.json` (instrucciones en el bloque `_README` al inicio del archivo) y hacé commit. Cloudflare Pages auto-deploya en ~30 segundos.
