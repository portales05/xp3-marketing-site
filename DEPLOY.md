# Deploy XP3 — Guía paso a paso

Este documento te lleva de cero al sitio en vivo en `xp3.com.mx` con chat y analytics funcionando. Está organizado en **3 fases**: cada fase termina con algo verificable que funciona, así si te trabás en una, no pierdes lo de las anteriores.

**Tiempo total estimado:** ~2 horas si todo va fluido, repartidas en 3 sesiones de 30-45 min.

**Costo total:** ~$10-15 USD/mes (Railway $5 + tokens DeepSeek/Perplexity en uso real).

---

## Resumen de la arquitectura

```
┌─────────────────────────┐         ┌─────────────────────────┐
│   xp3.com.mx (Squarespace) │ DNS │ Cloudflare Pages          │
│   solo registrar dominio   │ ───▶│ sitio estático            │
└─────────────────────────┘         │ (index.html, content.json,│
                                     │  assets, aviso-priv...)   │
                                     └────────┬────────────────┘
                                              │ fetch
                                              ▼
                                     ┌─────────────────────────┐
                                     │ Railway (Node.js)         │
                                     │ /api/chat backend         │
                                     │ DeepSeek + Perplexity     │
                                     └────────┬────────────────┘
                                              │ writes
                                              ▼
                                     ┌─────────────────────────┐
                                     │ Firestore (Google Cloud)  │
                                     │ conversations collection  │
                                     └─────────────────────────┘
```

---

## FASE 1 · Sitio en vivo (~30 min)

**Resultado al final de esta fase:** `https://xp3.com.mx` muestra el sitio. El chat dará error si lo abren porque el backend aún no está; lo arreglamos en Fase 2.

### Paso 1.1 — Subir archivos a Cloudflare Pages

1. Andá a [dash.cloudflare.com](https://dash.cloudflare.com) y creá una cuenta gratis (con tu email de XP3).
2. En el menú lateral: **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
3. Nombre del proyecto: `xp3-marketing` (este nombre forma parte de la URL temporal `xp3-marketing.pages.dev`).
4. Arrastrá la carpeta `xp3/` completa (con `index.html`, `content.json`, `aviso-de-privacidad.html`, la carpeta `assets/`, los `.txt` y `.xml`). Esperá a que termine la subida.
5. **Deploy site**.

Vas a ver una URL tipo `https://xp3-marketing.pages.dev`. Abrila — el sitio ya está en vivo, sin dominio custom todavía. Verificá que veas:
- El logo XP3 en la nav.
- "Exponential Performance · Hub digital" en el hero.
- Las 7 soluciones, alianzas con logos reales.
- El widget del chat abajo a la derecha (no lo abras todavía, dará error).

### Paso 1.2 — Configurar el dominio custom

En el dashboard de tu proyecto de Pages:

1. Pestaña **Custom domains** → **Set up a custom domain**.
2. Ingresá `xp3.com.mx` (sin `www`, el apex). Cloudflare te va a mostrar instrucciones DNS.
3. Cloudflare te dará dos opciones: (A) cambiar nameservers (recomendado), o (B) agregar un CNAME. **Elegí cambiar nameservers** porque te da SSL automático más rápido.
4. Cloudflare te muestra dos nameservers tipo `julia.ns.cloudflare.com` y `nick.ns.cloudflare.com`. Anotalos.

### Paso 1.3 — Apuntar Squarespace a Cloudflare

1. Andá a [account.squarespace.com/domains](https://account.squarespace.com/domains).
2. Click en `xp3.com.mx` → **DNS settings** o **Use Custom Nameservers**.
3. Reemplazá los nameservers de Squarespace por los dos que te dio Cloudflare en el paso anterior.
4. Guardá.

**Tiempo de propagación:** entre 10 min y 4 horas. Lo más común es 30-60 min. Podés verificar en [whatsmydns.net](https://www.whatsmydns.net/) buscando los nameservers de tu dominio.

### Paso 1.4 — Agregar también `www`

Una vez que el apex `xp3.com.mx` esté funcionando:

1. En Cloudflare Pages → **Custom domains** → **Set up a custom domain** → ingresá `www.xp3.com.mx`.
2. Cloudflare lo agrega automáticamente porque ya controla los nameservers.
3. En **Rules** (menú lateral de Cloudflare) → **Redirect Rules** → creá una regla:
   - When: `Hostname equals www.xp3.com.mx`
   - Then: `Static → 301 redirect → https://xp3.com.mx/$1`

Esto hace que `www.xp3.com.mx/cualquier-cosa` redirija a `xp3.com.mx/cualquier-cosa`, manteniendo apex como dominio canónico.

### Paso 1.5 — Verificación de Fase 1

Abrí estas URLs y confirmá:

- ✅ `https://xp3.com.mx` — carga el sitio con candado SSL verde.
- ✅ `https://www.xp3.com.mx` — redirige a `https://xp3.com.mx`.
- ✅ `https://xp3.com.mx/aviso-de-privacidad.html` — abre la página de privacidad.
- ✅ Hard-refresh con Ctrl+Shift+R: el sitio sigue idéntico.
- ✅ Abrir consola del browser (F12) → no debería haber errores rojos.

Si algo falla acá, **no avances a Fase 2**. Decime qué ves y lo debuggeamos.

---

## FASE 2 · Chat conectado (~45 min)

**Resultado al final:** el chat responde preguntas sobre XP3 y tendencias en vivo. Las conversaciones quedan registradas en Firestore.

### Paso 2.1 — Conseguir API keys de DeepSeek y Perplexity

**DeepSeek** (modo XP3, ~$0.14 por millón de tokens — extremadamente barato):
1. Andá a [platform.deepseek.com](https://platform.deepseek.com), creá cuenta.
2. **API Keys** → **Create new API key**. Nombrala `xp3-prod`.
3. Copiá la key (empieza con `sk-…`). **No vas a poder verla otra vez**, guardala segura.
4. Recargá créditos iniciales: USD$5 alcanza para miles de conversaciones.

**Perplexity** (modo Tendencias, ~$1 por millón de tokens):
1. Andá a [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api), creá cuenta.
2. Generá una API key (empieza con `pplx-…`).
3. Cargá USD$5 de créditos iniciales.

### Paso 2.2 — Crear proyecto de Google Cloud y Firestore

1. Andá a [console.cloud.google.com](https://console.cloud.google.com).
2. Arriba a la izquierda, click en el selector de proyecto → **New Project**.
3. Nombre: `xp3-marketing-prod`. Click **Create**.
4. Seleccioná el proyecto recién creado.
5. En el buscador de arriba, escribí "Firestore" → **Firestore API** → **Enable**.
6. Una vez habilitada → **Create database** → modo **Native** → región `nam5 (United States)` o `us-central1` (más cerca de México que las europeas).
7. **Start in production mode** (no test mode). Confirmá.

### Paso 2.3 — Crear service account para que el backend escriba

1. En el buscador: "Service Accounts" → **IAM & Admin → Service Accounts**.
2. **Create Service Account**:
   - Nombre: `xp3-agent-writer`
   - Descripción: `Backend writes anonymized chat logs`
3. Permisos: rol **Cloud Datastore User** (es el rol mínimo que permite escribir en Firestore).
4. Skip los pasos opcionales → **Done**.
5. Click en la service account recién creada → pestaña **Keys** → **Add Key** → **Create new key** → **JSON** → **Create**.
6. Se descarga un archivo `.json`. **Guardalo seguro** — no se puede regenerar, solo crear uno nuevo.

### Paso 2.4 — Subir backend a Railway

1. Andá a [railway.app](https://railway.app) y entrá con GitHub o email.
2. **New Project** → **Empty Project**.
3. Nombre: `xp3-agent`.
4. Dentro del proyecto: **+ New** → **Empty Service** → settings → **Source** → **Connect Repo** o subir como zip.

Alternativa **sin GitHub**: instalá Railway CLI:
```bash
npm install -g @railway/cli
railway login
cd /ruta/al/xp3-agent
railway link    # selecciona el proyecto
railway up      # sube y deploya
```

5. Una vez deployado, en **Settings → Variables** agregá:

```
DEEPSEEK_API_KEY=sk-…tu key de DeepSeek
PERPLEXITY_API_KEY=pplx-…tu key de Perplexity
ALLOWED_ORIGIN=https://xp3.com.mx
FIRESTORE_PROJECT_ID=xp3-marketing-prod
FIRESTORE_CREDENTIALS_JSON={"type":"service_account",...}  ← contenido del JSON descargado, en una sola línea
```

**Cómo poner el JSON en una sola línea:** abrí el archivo descargado, copiá TODO el contenido tal cual (Railway lo soporta multi-línea), o usá `cat archivo.json | tr -d '\n'` si querés en una línea limpia.

6. **Settings → Networking → Generate Domain** → te da una URL tipo `xp3-agent-production.up.railway.app`.

### Paso 2.5 — Verificar que el backend está vivo

Abrí en el browser: `https://tu-url-de-railway.up.railway.app/health`

Deberías ver:
```json
{
  "status": "ok",
  "service": "xp3-agent",
  "timestamp": "...",
  "integrations": {
    "deepseek": true,
    "perplexity": true,
    "firestore": true
  }
}
```

Si alguno está en `false`, esa variable de entorno está mal cargada. Verificá tipos exactos en Railway Variables (un espacio al final del valor lo rompe).

### Paso 2.6 — Conectar el frontend al backend

Tenés dos opciones para que el sitio llame al backend.

**Opción A (más simple): subdominio del backend**

1. En Railway → Settings → Networking → **Custom Domain** → ingresá `agent.xp3.com.mx`.
2. Railway te da un CNAME target tipo `xp3-agent-production.up.railway.app`.
3. En Cloudflare DNS: agregá un record CNAME `agent` → `xp3-agent-production.up.railway.app` (Proxy: **DNS only / gris**, no naranja).
4. Esperá 2-5 min para propagación.
5. En `index.html` cambiá la línea (cerca de la línea 1984):
   ```js
   const API_ENDPOINT = "/api/chat";
   ```
   a:
   ```js
   const API_ENDPOINT = "https://agent.xp3.com.mx/api/chat";
   ```
6. Subí el `index.html` actualizado a Cloudflare Pages.

**Opción B (avanzada): Cloudflare Workers para mismo origen**

Más complejo pero el chat queda como `xp3.com.mx/api/chat` (mismo origen, sin CORS). Si querés ir por aquí avisame y te paso los pasos del Worker.

### Paso 2.7 — Verificación de Fase 2

1. ✅ Abrí `xp3.com.mx`, click en el botón del chat.
2. ✅ Escribí: "¿Qué es XP3?" → debería responder en 1-3 segundos sobre la consultoría.
3. ✅ Cambiá al tab **Tendencias · live** → escribí: "Qué tendencias hay en TikTok ads esta semana" → debería responder con citas (chips clicables abajo del bubble).
4. ✅ Andá a [Firestore console](https://console.cloud.google.com/firestore/data) → colección `conversations` → deberías ver tus dos conversaciones de prueba.

Si no aparecen en Firestore pero el chat respondió bien, el backend está perdiéndolas — abrí los logs de Railway (Deployments → click en el último → Logs) y buscá líneas que digan `[Firestore]`.

---

## FASE 3 · Dashboard de analytics (~30 min) — opcional pero potente

**Resultado al final:** Looker Studio muestra dashboards en tiempo real con las métricas que pediste.

### Paso 3.1 — Conectar Firestore a BigQuery

Looker Studio no consulta Firestore directamente; necesita BigQuery como intermediario.

1. En Google Cloud → **Firestore** → tu base de datos → **Import/Export** → **Schedule export to BigQuery**.
2. Setealo para correr cada 24 horas. Crea un dataset BigQuery nuevo: `xp3_analytics`.

(Alternativa: extensión de Firebase "Stream Firestore to BigQuery" para datos en tiempo real, pero la export programada está perfecta para empezar.)

### Paso 3.2 — Crear el dashboard en Looker Studio

1. Andá a [lookerstudio.google.com](https://lookerstudio.google.com).
2. **Create** → **Data source** → **BigQuery** → conectá al dataset `xp3_analytics` → tabla `conversations_raw_latest`.
3. **Create Report** y armá tres widgets:

**Widget 1 — Distribución de modos (XP3 vs Tendencias):**
- Tipo: Pie chart
- Dimensión: `mode`
- Métrica: `Record Count`

**Widget 2 — Preguntas más frecuentes:**
- Tipo: Table
- Dimensión: `userMessageNormalized`
- Métrica: `Record Count`
- Sort: descending
- Limit: 20 rows

**Widget 3 — Volumen por día y modo:**
- Tipo: Time series
- Dimensión: `createdAt` (por día)
- Breakdown: `mode`
- Métrica: `Record Count`

Compartí el report con tu equipo (View only) y listo, dashboards funcionando.

---

## Notas operativas

### Cómo editás contenido del sitio una vez en vivo

1. Editás `content.json` en tu computadora.
2. En Cloudflare Pages → tu proyecto → **Create deployment** → **Upload assets** → arrastrás SOLO el `content.json` actualizado (o todo el folder, da igual).
3. Refrescás `xp3.com.mx` con Ctrl+Shift+R → cambios visibles.

### Cómo cambiás un texto del aviso de privacidad

Ese SÍ requiere subir el `aviso-de-privacidad.html` actualizado (no es content-driven). Misma mecánica de subida.

### Monitoreo

- **Estado del chat:** `agent.xp3.com.mx/health` te dice si todo está conectado.
- **Errores recientes:** Railway dashboard → Deployments → Logs.
- **Conversaciones:** Firestore console → conversations.
- **Costos:** dashboards de DeepSeek/Perplexity (suelen ser <$5/mes con tráfico orgánico inicial).

### Si necesitás apagar el chat temporalmente

En Railway Variables agregá `FIRESTORE_DISABLE=true` (si querés solo apagar logging) o pausá el servicio entero (Railway → Settings → Pause). El sitio sigue funcionando, el chat dará error si lo abren.

---

## Soporte y troubleshooting

**El chat dice "Hubo un problema conectando con el asistente":**
1. Abrí `agent.xp3.com.mx/health`. Si no carga, Railway está caído o el dominio no propagó.
2. Si carga pero `deepseek: false`, falta o está mal la API key.
3. Mirá los logs de Railway para el detalle exacto del error.

**Los cambios al `content.json` no se ven:**
1. Hard refresh: Ctrl+Shift+R (PC) o Cmd+Shift+R (Mac).
2. En Pages → Deployments → verificá que el último deployment incluye tu `content.json` editado.
3. Probá en una pestaña de incógnito por si es cache local.

**Firestore no recibe conversaciones:**
1. `agent.xp3.com.mx/health` → ¿`firestore: true`?
2. Logs de Railway → buscá "[Firestore]" → si dice "init failed", es que el JSON de credenciales está mal pegado (un caracter de más o menos rompe el parse).
3. En Google Cloud → IAM → confirmá que la service account tiene rol "Cloud Datastore User".

**Para cualquier otro problema:** los archivos de validación están en este mismo proyecto. Decime qué ves exactamente y lo resolvemos.

---

**Última actualización:** 8 de mayo de 2026.
