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
export async function claude(body, track) {
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
  if (Array.isArray(track)) track.push(j);
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

/* ---------- Kostenbremse: festes Monatsbudget ----------
 * Vor jeder KI-Anfrage wird der Höchstbetrag dieser Anfrage reserviert (in Tausendstel Euro).
 * Würde das Monatsbudget damit überschritten, wird die Anfrage gar nicht erst gestellt.
 * Nach der Antwort werden die echten Kosten aus den Token-Zahlen der Claude-API eingetragen.
 * Ohne Tabelle immo_spend wird keine KI-Anfrage ausgeführt (sicher statt teuer).
 * Einstellbar per Vercel-Variable: BUDGET_MONTH_EUR (gesamt, Standard 10), BUDGET_USER_EUR (pro Konto),
 * PRICE_IN_PER_MTOK / PRICE_OUT_PER_MTOK (Preis des Modells in $ pro Million Token, Standard 2 / 10). */
const PIN = Number(process.env.PRICE_IN_PER_MTOK) || 2;
const POUT = Number(process.env.PRICE_OUT_PER_MTOK) || 10;
const milliOf = (inT, outT, searches) => Math.ceil((inT * PIN + outT * POUT) / 1000 + searches * 10); // 1 Suche = 0,01 $
// Obergrenzen je Anfrageart: Eingabe-Token, Ausgabe-Token, Websuchen (inkl. Folge-Runde)
const CAPS = {
  analyze:   { in: 25000,  out: 4000,  s: 0 },
  chat:      { in: 30000,  out: 2000,  s: 0 },
  ort:       { in: 120000, out: 6000,  s: 5 },
  bewertung: { in: 180000, out: 12000, s: 8 },
  market:    { in: 120000, out: 8000,  s: 8 },
};
export const estimateMilli = (kind) => { const c = CAPS[kind] || CAPS.chat; return milliOf(c.in, c.out, c.s); };
export function costMilli(msgs) {
  let m = 0;
  for (const msg of msgs || []) {
    const u = msg?.usage || {};
    const inT = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25 + (u.cache_read_input_tokens || 0) * 0.1;
    m += milliOf(inT, u.output_tokens || 0, u.server_tool_use?.web_search_requests || 0);
  }
  return m;
}
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
const budgets = () => {
  const total = (Number(process.env.BUDGET_MONTH_EUR) || 10) * 1000;
  const user = (Number(process.env.BUDGET_USER_EUR) || total / 1000) * 1000;
  return { total, user };
};
export async function spentThisMonth(userId) {
  const rows = await sbAdmin(`immo_spend?at=gte.${encodeURIComponent(monthStart())}&select=user_id,milli&limit=50000`);
  let total = 0, mine = 0;
  for (const r of rows || []) { total += r.milli || 0; if (userId && r.user_id === userId) mine += r.milli || 0; }
  return { total, mine };
}
export async function reserveBudget(user, kind) {
  const est = estimateMilli(kind), B = budgets();
  let sp;
  try { sp = await spentThisMonth(user?.id); }
  catch (e) {
    console.error("immo_spend nicht lesbar:", e.message);
    return { ok: false, code: "budget_setup", message: "Der Kostenschutz ist noch nicht eingerichtet. Bitte supabase/schema.sql in Supabase ausführen." };
  }
  if (sp.total + est > B.total)
    return { ok: false, code: "budget", message: `Das KI-Budget für diesen Monat (${(B.total / 1000).toLocaleString("de-DE")} €) ist aufgebraucht. Am 1. des nächsten Monats geht es weiter.` };
  if (user && sp.mine + est > B.user)
    return { ok: false, code: "budget", message: `Dein KI-Budget für diesen Monat (${(B.user / 1000).toLocaleString("de-DE")} €) ist aufgebraucht.` };
  try {
    const rows = await sbAdmin("immo_spend", {
      method: "POST", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ user_id: user?.id || null, kind, milli: est, est: true }),
    });
    return { ok: true, id: rows?.[0]?.id, est };
  } catch (e) {
    console.error("immo_spend schreiben fehlgeschlagen:", e.message);
    return { ok: false, code: "budget_setup", message: "Der Kostenschutz konnte die Anfrage nicht vormerken. Bitte später nochmal versuchen." };
  }
}
export async function settleBudget(r, msgs) {
  if (!r?.id) return;
  try {
    await sbAdmin(`immo_spend?id=eq.${r.id}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ milli: costMilli(msgs), est: false }),
    });
  } catch (e) { console.error("Kosten nachtragen fehlgeschlagen (Reservierung bleibt stehen):", e.message); }
}
export const budgetReply = (res, b) => res.status(b.code === "budget_setup" ? 503 : 429).json({ error: b.code, message: b.message });
export const budgetInfo = budgets;
