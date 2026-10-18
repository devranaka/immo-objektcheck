// Gemeinsame Helfer für die Serverfunktionen (Dateien mit "_" sind auf Vercel keine eigenen Routen).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

/** Prüft das Supabase-Login-Token aus dem Header und gibt den Nutzer zurück (oder null). */
export async function requireUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || !SUPABASE_URL || !SUPABASE_ANON_KEY) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  const allowed = (process.env.ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(user.email || "").toLowerCase())) return null;
  return user;
}

/** Ruft die Claude-API auf. Gibt die komplette Antwort zurück. */
export async function claude(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("ANTHROPIC_API_KEY fehlt in Vercel"), { code: "config" });
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: process.env.AI_MODEL || "claude-sonnet-5-5", ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const code = r.status === 429 ? "rate_limited" : r.status === 401 ? "config" : "upstream_error";
    throw Object.assign(new Error(j?.error?.message || `Claude-API Fehler ${r.status}`), { code });
  }
  return j;
}

export const textOf = (msg) =>
  (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();

/** Holt das erste JSON-Objekt aus einem Text. */
export function parseJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : text;
  const a = src.indexOf("{"), b = src.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(src.slice(a, b + 1)); } catch { return null; }
}

/** Supabase REST mit Service-Schlüssel (nur serverseitig). */
export async function sbAdmin(path, init = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !key) throw Object.assign(new Error("Supabase-Schlüssel fehlen in Vercel"), { code: "config" });
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    // Alte Schlüssel (eyJ…) zusätzlich als Bearer senden, neue Secret Keys (sb_secret_…) nur als apikey
    headers: { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}), "content-type": "application/json", ...(init.headers || {}) },
  });
  if (!r.ok) throw Object.assign(new Error(`Supabase ${r.status}: ${await r.text()}`), { code: "upstream_error" });
  return r.status === 204 ? null : r.json();
}

/** Tageslimit pro Nutzer und Art der Anfrage. Zählt VOR dem KI-Aufruf, damit auch Fehlversuche zählen.
 *  Limits per Vercel-Variable änderbar: LIMIT_ANALYZE, LIMIT_CHAT, LIMIT_ORT, LIMIT_MARKET, LIMIT_BEWERTUNG. */
const DAILY = { analyze: 15, chat: 80, ort: 8, market: 3, bewertung: 4 };
export async function useQuota(user, kind) {
  const lim = Number(process.env[`LIMIT_${kind.toUpperCase()}`]) || DAILY[kind] || 10;
  const day = new Date().toISOString().slice(0, 10);
  let n = 0;
  try {
    const rows = await sbAdmin(`immo_usage?user_id=eq.${user.id}&day=eq.${day}&kind=eq.${kind}&select=n`);
    n = rows?.[0]?.n || 0;
  } catch (e) {
    console.error("Tabelle immo_usage fehlt oder ist nicht erreichbar (supabase/schema.sql ausführen):", e.message);
    return { ok: true, n: 0, lim };
  }
  if (n >= lim) return { ok: false, n, lim };
  try {
    await sbAdmin("immo_usage?on_conflict=user_id,day,kind", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ user_id: user.id, day, kind, n: n + 1 }),
    });
  } catch (e) { console.error("immo_usage schreiben fehlgeschlagen:", e.message); }
  return { ok: true, n: n + 1, lim };
}
export const limitReply = (res, q) =>
  res.status(429).json({ error: "limit", message: `Tageslimit erreicht (${q.lim} pro Tag). Morgen geht es weiter.` });
