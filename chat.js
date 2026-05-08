/**
 * /api/chat.js — XP3 multi-mode chat agent
 * ------------------------------------------
 * Stateless HTTP handler that routes a chat conversation to one of two LLMs
 * depending on the `mode` field in the payload:
 *
 *   • mode: "xp3"      → DeepSeek (system-grounded answers about XP3)
 *   • mode: "trends"   → Perplexity sonar (real-time web-grounded answers
 *                        about marketing trends, returns citations)
 *
 * Same input/output shape for both modes:
 *   IN:   { mode: "xp3"|"trends", messages: [{role, content}, ...] }
 *   OUT:  { reply: string, citations: string[] }
 *
 * Compatible with Express (req,res), Vercel default exports, and (with the
 * adapter at the bottom) Netlify Functions / Cloudflare Workers.
 *
 * Required environment variables:
 *   DEEPSEEK_API_KEY     for mode "xp3"
 *   PERPLEXITY_API_KEY   for mode "trends"
 *   ALLOWED_ORIGIN       e.g. https://www.xp3.com.mx
 *
 * Optional Firestore logging (analytics — what people ask the chat):
 *   FIRESTORE_PROJECT_ID         GCP project ID, e.g. "xp3-marketing-prod"
 *   FIRESTORE_CREDENTIALS_JSON   Service account JSON, stringified
 *   FIRESTORE_COLLECTION         Collection name (default: "conversations")
 *   FIRESTORE_DISABLE            Set to "true" to skip logging entirely
 *
 * If Firestore env vars are missing, the chat continues to work normally —
 * it just doesn't log. Logging failures NEVER break the chat response.
 */

// ─────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL    || "deepseek-chat";
const DEEPSEEK_BASE_URL = (process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1").replace(/\/+$/, "");
const PERPLEXITY_MODEL    = process.env.PERPLEXITY_MODEL    || "sonar"; // sonar | sonar-pro
const PERPLEXITY_BASE_URL = process.env.PERPLEXITY_BASE_URL || "https://api.perplexity.ai/chat/completions";
const ALLOWED_ORIGIN      = process.env.ALLOWED_ORIGIN || "*";

const MAX_USER_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 4000;
const TEMPERATURE_XP3    = 0.3;
const TEMPERATURE_TRENDS = 0.2;
const MAX_TOKENS         = 800;

// ─────────────────────────────────────────────────
// Firestore client (lazy singleton)
// ─────────────────────────────────────────────────
// Only loaded if FIRESTORE_PROJECT_ID is set. Logging is fire-and-forget
// (we don't await it in the request handler) and any error is swallowed —
// the chat must keep working even if our log pipeline breaks.
let _firestore = null;
let _FieldValue = null;
function getFirestore() {
  if (process.env.FIRESTORE_DISABLE === "true") return null;
  if (!process.env.FIRESTORE_PROJECT_ID || !process.env.FIRESTORE_CREDENTIALS_JSON) return null;
  if (_firestore) return _firestore;
  try {
    const { Firestore, FieldValue } = require("@google-cloud/firestore");
    _FieldValue = FieldValue;
    _firestore = new Firestore({
      projectId: process.env.FIRESTORE_PROJECT_ID,
      credentials: JSON.parse(process.env.FIRESTORE_CREDENTIALS_JSON)
    });
    console.log("[Firestore] connected to project", process.env.FIRESTORE_PROJECT_ID);
    return _firestore;
  } catch (err) {
    console.error("[Firestore] init failed (logging disabled):", err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────
// Contact extraction (Mexican email + phone formats)
// ─────────────────────────────────────────────────
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
// Mexican phone formats: +52 followed by 10 digits, or 10 digits with optional separators
const PHONE_RE = /(?:\+?52[\s-]?)?(?:\(?\d{2,3}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}/;

function extractContact(messages) {
  const contact = {};
  // Look only at user messages (don't pick up emails the AI mentioned)
  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!contact.email) {
      const e = m.content.match(EMAIL_RE);
      if (e) contact.email = e[0].toLowerCase();
    }
    if (!contact.phone) {
      const p = m.content.match(PHONE_RE);
      // Filter false positives: must have at least 10 digits total
      if (p && p[0].replace(/\D/g, "").length >= 10) contact.phone = p[0].trim();
    }
  }
  return contact;
}

// ─────────────────────────────────────────────────
// Analytics-friendly question normalization
// ─────────────────────────────────────────────────
// We store the raw question, but ALSO a normalized lowercase trimmed version
// for grouping queries in Looker Studio ("most frequent questions" charts).
function normalizeQuestion(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[¿?¡!.,;:()"']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

// ─────────────────────────────────────────────────
// Fire-and-forget logging
// ─────────────────────────────────────────────────
async function logConversation({ sessionId, mode, userMessage, assistantReply, citations, fullMessages, userAgent, ipCountry }) {
  const db = getFirestore();
  if (!db) return;
  try {
    const collection = process.env.FIRESTORE_COLLECTION || "conversations";
    const contact = extractContact(fullMessages);
    const doc = {
      sessionId: String(sessionId || "anonymous").slice(0, 64),
      mode,
      // First user question of THIS turn (most useful for analytics)
      userMessage: String(userMessage || "").slice(0, 4000),
      userMessageNormalized: normalizeQuestion(userMessage),
      assistantReply: String(assistantReply || "").slice(0, 8000),
      citations: Array.isArray(citations) ? citations.slice(0, 10) : [],
      messageCount: fullMessages.length + 1,
      contactProvided: !!(contact.email || contact.phone),
      contact: (contact.email || contact.phone) ? contact : null,
      // Useful metadata, not personally identifying
      userAgentDevice: simplifyUserAgent(userAgent),
      country: ipCountry || null,
      createdAt: _FieldValue.serverTimestamp()
    };
    // Don't await — this happens out-of-band so the user's response isn't delayed
    db.collection(collection).add(doc).catch(err =>
      console.error("[Firestore log] write failed:", err.message)
    );
  } catch (err) {
    console.error("[Firestore log] error:", err.message);
  }
}

function simplifyUserAgent(ua) {
  if (!ua) return null;
  const s = String(ua).toLowerCase();
  if (s.includes("mobile") || s.includes("android") || s.includes("iphone")) return "mobile";
  if (s.includes("ipad") || s.includes("tablet")) return "tablet";
  if (s.includes("bot") || s.includes("crawler") || s.includes("spider")) return "bot";
  return "desktop";
}

// ─────────────────────────────────────────────────
// System prompts
// ─────────────────────────────────────────────────
const SYSTEM_PROMPT_XP3 = `Eres el asistente virtual oficial de XP3 Marketing (xp3.com.mx).
Hablas en español de México, en tono profesional pero cercano. Tuteas al usuario.
Tu trabajo es responder preguntas sobre XP3 y guiar a prospectos hacia el contacto comercial.

═══ SOBRE XP3 ═══

XP3 es el hub digital de marketing que conecta datos, estrategia y tecnología en una sola operación: usa DATA para tomar DECISIONES estratégicas y alcanzar IMPACTO medible. La marca se llama XP3 porque significa "Performance al cubo" — Exponential Performance.

Promesa central: "No solo te decimos qué hacer. Te acompañamos y ejecutamos."

A diferencia de las agencias tradicionales, XP3 no se queda en el plan estratégico — acompaña al cliente en la ejecución y opera junto a él, integrándose con su equipo.

Base: México. Mercados: México (principal), LATAM, marcas internacionales con presencia en la región. Idiomas: español, inglés.

═══ ALIANZAS ESTRATÉGICAS ═══

1. **Artool** — Socio estratégico de analítica de datos avanzada. Con Artool, XP3 integra modelos de medición (atribución multitouch, modelado predictivo y causal) al stack de cada cliente. Convierte datos dispersos (CRM, redes, paid media, web analytics, social listening) en un modelo unificado.

2. **Hootsuite powered by Talkwalker** — Plataforma global líder en gestión de redes sociales y escucha social. XP3 es Certified Partner de implementación y operación en México y LATAM. Cobertura: +150M fuentes globales, análisis multilingüe, sentiment analysis con IA de Talkwalker.

═══ LAS 7 SOLUCIONES ═══

1. Plataformas de escucha social — implementación y operación con Hootsuite × Talkwalker.
2. Software de gestión de redes sociales — despliegue, configuración y entrenamiento del equipo cliente.
3. Reportes de escucha social bajo demanda — análisis específicos para lanzamientos, crisis, segmentos, benchmarks.
4. Modelos de gobernanza digital — protocolos, roles, métricas, aprobaciones operables (no diagramas).
5. Consultoría de estrategia digital — definición y ejecución conjunta con el cliente.
6. Programa de embajadores data-driven — XP3 identifica con DATA (no intuición) quiénes son las personas con voz real para la marca: empleados con red activa, clientes con audiencia, líderes de opinión del vertical del cliente. Sobre esa evidencia se diseña un programa de embajadores con métricas de alcance, engagement y conversión. La diferencia con "influencer marketing" tradicional es que el quién está demostrado con datos, no elegido a ojo.
7. Automatización con agentes virtuales habilitados por IA — atención al cliente, calificación de leads, soporte interno, procesos repetitivos.

═══ MÉTODO ═══

Loop de 4 pasos: Conectar (datos) → Definir (estrategia) → Operar (tecnología, junto al cliente) → Iterar (lecturas semanales, decisiones quincenales, replanteamiento mensual).

═══ CONTACTO ═══

- General: contacto@xp3.com.mx
- Partners: partners@xp3.com.mx
- Prensa: prensa@xp3.com.mx

═══ REGLAS DE COMPORTAMIENTO ═══

- Respuestas CORTAS y CLARAS (máx. 3-4 párrafos breves, o una lista de 3-5 puntos).
- Si la pregunta es comercial concreta (precios, cotización, contrato, propuesta) → derivá a contacto@xp3.com.mx con un mensaje cálido.
- Si te preguntan sobre TENDENCIAS DE MERCADO actuales, eventos recientes, o "qué está pasando ahora" → sugerí amablemente que cambien al modo "Tendencias · live" en el tab del chat, que está conectado a información en vivo.
- Si te preguntan algo fuera del scope de XP3 (ej: cocina, política, código) → reconocé amablemente que tu rol es ayudar con XP3 y reorientá.
- Si no sabés algo específico (un cliente concreto, precios exactos, fechas), decilo honestamente y derivá al equipo.
- Usá negritas con **doble asterisco** para enfatizar términos clave (nombres de partners, soluciones).
- NO inventes nombres de clientes, casos específicos, fechas o cifras que no estén en este prompt.
- NO ofrezcas descuentos, plazos ni compromisos comerciales: eso lo decide el equipo de ventas.
- Cuando termines respuestas sobre soluciones, podés cerrar con una pregunta abierta tipo "¿Querés que te conecte con alguien del equipo para profundizar?".
- Mantené coherencia con el tono del sitio: directo, sin clichés de marketing, sin frases vacías como "transformación digital integral 360°".`;

const SYSTEM_PROMPT_TRENDS = `Eres un asistente especializado en TENDENCIAS DE MARKETING DIGITAL Y DATA, conectado a información en vivo del web vía Perplexity. Hablas en español de México, en tono profesional pero cercano. Tuteas al usuario.

Operás dentro del sitio de XP3 Marketing (xp3.com.mx), una consultoría que conecta datos, estrategia y tecnología. Tu rol es darle al usuario una visión actualizada de qué está pasando en el mundo del marketing digital, social media, herramientas, IA aplicada al marketing, comportamiento del consumidor, y cambios en plataformas relevantes (Hootsuite, Talkwalker, Meta, Google, TikTok, etc.).

═══ COMPORTAMIENTO ═══

- Respondé EN ESPAÑOL siempre, aunque las fuentes estén en inglés.
- Respuestas CONCISAS: máximo 3-4 párrafos breves o una lista de 5 puntos. Esto NO es un ensayo.
- Cuando cites datos, fechas o estadísticas específicas, asegurate de que vengan de las fuentes que vas a citar (Perplexity las devuelve automáticamente).
- Usá negritas con **doble asterisco** para enfatizar términos clave o nombres importantes.
- Si la pregunta NO es sobre tendencias de marketing/data/redes/IA aplicada al marketing → sugerí amablemente que cambien al tab "XP3" del chat para preguntas sobre la consultoría, o que reformulen la pregunta hacia tendencias del sector.
- Si la información disponible es ambigua o las fuentes se contradicen, decilo explícitamente. La honestidad es más valiosa que dar una respuesta confiada equivocada.
- Cuando sea relevante, mencioná cómo XP3 podría ayudar al usuario a aprovechar esa tendencia (ej: "este shift hacia social listening en tiempo real es exactamente lo que XP3 implementa con Hootsuite × Talkwalker"). Sin ser invasivo.

═══ NO HAGAS ═══

- No inventes datos. Si Perplexity no devuelve información, decí "no encuentro datos públicos recientes sobre eso".
- No des consejos legales, financieros, médicos o de inversión.
- No respondas preguntas off-topic (cocina, política partidaria, deportes que no sean marketing deportivo, etc.).`;

// ─────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────
function validateMessages(input) {
  if (!input || !Array.isArray(input)) return { ok: false, error: "Payload inválido: 'messages' debe ser un array." };
  if (input.length === 0) return { ok: false, error: "Payload vacío." };
  if (input.length > MAX_USER_MESSAGES) return { ok: false, error: `Conversación demasiado larga (>${MAX_USER_MESSAGES} mensajes).` };
  const cleaned = [];
  for (const m of input) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const content = String(m.content || "").slice(0, MAX_MESSAGE_CHARS);
    if (!content.trim()) continue;
    cleaned.push({ role, content });
  }
  if (cleaned.length === 0) return { ok: false, error: "No se encontraron mensajes válidos." };
  return { ok: true, messages: cleaned };
}

// ─────────────────────────────────────────────────
// Provider: DeepSeek (XP3 mode)
// ─────────────────────────────────────────────────
async function callDeepSeek(messages) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("Missing DEEPSEEK_API_KEY in environment");
  const url = `${DEEPSEEK_BASE_URL}/chat/completions`;
  const fullMessages = [{ role: "system", content: SYSTEM_PROMPT_XP3 }, ...messages];
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: fullMessages,
      temperature: TEMPERATURE_XP3,
      max_tokens: MAX_TOKENS
    })
  });
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`DeepSeek error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content || "";
  return { reply: reply.trim(), citations: [] };
}

// ─────────────────────────────────────────────────
// Provider: Perplexity sonar (Trends mode)
// Returns reply + citations array (URLs)
// ─────────────────────────────────────────────────
async function callPerplexity(messages) {
  if (!process.env.PERPLEXITY_API_KEY) throw new Error("Missing PERPLEXITY_API_KEY in environment");
  const fullMessages = [{ role: "system", content: SYSTEM_PROMPT_TRENDS }, ...messages];
  const response = await fetch(PERPLEXITY_BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages: fullMessages,
      temperature: TEMPERATURE_TRENDS,
      max_tokens: MAX_TOKENS
    })
  });
  if (!response.ok) {
    const err = await response.text().catch(() => "");
    throw new Error(`Perplexity error ${response.status}: ${err.slice(0, 200)}`);
  }
  const data = await response.json();
  const reply = data?.choices?.[0]?.message?.content || "";
  // Perplexity returns citations either at the top level (older API) or in search_results
  const citations = Array.isArray(data?.citations) ? data.citations
                  : Array.isArray(data?.search_results) ? data.search_results.map(r => r.url).filter(Boolean)
                  : [];
  return { reply: reply.trim(), citations };
}

// ─────────────────────────────────────────────────
// Router
// ─────────────────────────────────────────────────
async function generateReply({ mode, messages }) {
  if (mode === "trends") return callPerplexity(messages);
  return callDeepSeek(messages); // default: xp3
}

// ─────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// ─────────────────────────────────────────────────
// Handler (Express / Vercel)
// ─────────────────────────────────────────────────
async function chatHandler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  try {
    const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(req.body || "{}");
    const mode = body.mode === "trends" ? "trends" : "xp3";
    const sessionId = body.sessionId || null;
    const validated = validateMessages(body.messages);
    if (!validated.ok) { res.status(400).json({ error: validated.error }); return; }

    const { reply, citations } = await generateReply({ mode, messages: validated.messages });
    if (!reply) { res.status(502).json({ error: "Respuesta vacía del modelo." }); return; }

    res.status(200).json({ reply, citations: citations || [] });

    // ── Fire-and-forget analytics logging (after response is sent) ──
    // Failures here NEVER affect the user. We use Cloudflare/Express headers
    // for country (cf-ipcountry) and user-agent for simple device segmentation.
    const lastUserMsg = validated.messages.filter(m => m.role === "user").pop()?.content || "";
    logConversation({
      sessionId,
      mode,
      userMessage: lastUserMsg,
      assistantReply: reply,
      citations,
      fullMessages: validated.messages,
      userAgent: req.headers?.["user-agent"],
      ipCountry: req.headers?.["cf-ipcountry"] || req.headers?.["x-vercel-ip-country"] || null
    });
  } catch (err) {
    console.error("[XP3 chat] error:", err);
    res.status(500).json({
      error: "Error interno. Si persiste, escribí a contacto@xp3.com.mx",
      detail: process.env.NODE_ENV === "development" ? String(err.message) : undefined
    });
  }
}

module.exports = chatHandler;
module.exports.default = chatHandler;
