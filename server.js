/**
 * server.js — XP3 Agent backend (Railway-ready)
 * ---------------------------------------------
 * Express server que expone /api/chat para el agente conversacional del sitio xp3.com.mx.
 * Aislado del backend de HarmonIA Insight: distinto repo, distinto deploy, distintos secrets.
 *
 * Endpoints:
 *   GET  /             → health check (texto plano)
 *   GET  /health       → health check (JSON, para monitoring)
 *   POST /api/chat     → endpoint del agente (requiere DEEPSEEK_API_KEY en env)
 */

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const chatHandler = require("./api/chat.js");

const app = express();
const PORT = process.env.PORT || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.xp3.com.mx";

// ─── Middleware base ───────────────────────────────
app.set("trust proxy", 1); // necesario en Railway para que rate-limit lea X-Forwarded-For correctamente
app.use(express.json({ limit: "100kb" })); // payload chico, evita abuso

// ─── CORS — solo el origen del sitio puede llamar al endpoint ───
const corsOptions = {
  origin: ALLOWED_ORIGIN === "*"
    ? "*"
    : ALLOWED_ORIGIN.split(",").map((o) => o.trim()), // soporta múltiples orígenes separados por coma
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
  maxAge: 86400
};

// ─── Rate limit — 30 mensajes por IP cada 10 minutos ───
// Es un techo razonable para uso humano normal y previene abuso básico.
const chatLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Demasiadas solicitudes en poco tiempo. Por favor, intenta de nuevo en unos minutos o escríbenos a contacto@xp3.com.mx"
  }
});

// ─── Routes ───────────────────────────────────────
app.get("/", (_req, res) => {
  res.type("text/plain").send("XP3 Agent · OK");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "xp3-agent",
    timestamp: new Date().toISOString(),
    integrations: {
      deepseek:   Boolean(process.env.DEEPSEEK_API_KEY),
      perplexity: Boolean(process.env.PERPLEXITY_API_KEY),
      firestore:  Boolean(process.env.FIRESTORE_PROJECT_ID && process.env.FIRESTORE_CREDENTIALS_JSON && process.env.FIRESTORE_DISABLE !== "true")
    }
  });
});

app.options("/api/chat", cors(corsOptions));
app.post("/api/chat", cors(corsOptions), chatLimiter, chatHandler);

// ─── 404 handler ──────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ─── Error handler ────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[server] uncaught error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ─── Start ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`▸ XP3 Agent running on port ${PORT}`);
  console.log(`▸ Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`▸ DeepSeek API:   ${process.env.DEEPSEEK_API_KEY ? "✓ configured" : "✗ MISSING (mode XP3 will fail)"}`);
  console.log(`▸ Perplexity API: ${process.env.PERPLEXITY_API_KEY ? "✓ configured" : "✗ MISSING (mode Tendencias will fail)"}`);
  console.log(`▸ Firestore log:  ${process.env.FIRESTORE_PROJECT_ID && process.env.FIRESTORE_CREDENTIALS_JSON ? "✓ enabled · project " + process.env.FIRESTORE_PROJECT_ID : "○ disabled (no analytics)"}`);
});
