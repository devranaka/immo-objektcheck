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
