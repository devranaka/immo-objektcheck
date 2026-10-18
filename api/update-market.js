// Aktualisiert die Marktdaten (Zinsen, KfW, Grunderwerbsteuer …) per Claude + Websuche
// und schreibt sie in Supabase. Läuft automatisch über Vercel Cron (siehe vercel.json)
// oder per Knopf im Tool (nur für angemeldete Nutzer aus ALLOWED_EMAILS).
import { requireUser, claude, textOf, parseJson, sbAdmin, useQuota, limitReply } from "./_lib.js";

const DOMAINS = [
  "drklein.de", "baufi24.de", "interhyp.de", "huettig-rompf.de", "kfw.de",
  "destatis.de", "baden-wuerttemberg.de", "bundesfinanzministerium.de", "mieterbund.de", "bundesbank.de", "pfandbrief.de",
];

const inRange = (v, lo, hi) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;

export default async function handler(req, res) {
  const cron = process.env.CRON_SECRET && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`;
  if (!cron) {
    const user = await requireUser(req);
    if (!user || !process.env.ALLOWED_EMAILS) return res.status(401).json({ error: "auth", message: "Nicht erlaubt." });
    const q = await useQuota(user, "market");
    if (!q.ok) return limitReply(res, q);
  }

  try {
    const rows = await sbAdmin("immo_market?id=eq.current&select=data");
    const old = rows?.[0]?.data || {};
    const today = new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });

    const prompt = `Heute ist der ${today}. Recherchiere mit der Websuche die AKTUELLEN Werte für den deutschen Immobilienmarkt.
Bisherige Werte (zum Vergleich): ${JSON.stringify({ zins: old.zins, aufschlag: old.aufschlag, kfw308: old.kfw308, kfw308Max: old.kfw308Max, grest: old.grest, baupreis: old.baupreis, mietpreisbremse: old.mietpreisbremse })}

Gesucht:
- zins: effektive Topzinsen Baufinanzierung für 5, 10, 15, 20, 30 Jahre Zinsbindung (bevorzugt drklein.de) und das Datum dieser Zinsen
- aufschlag: typischer Abstand eines Durchschnittsangebots zum Topzins bei 10 Jahren (z. B. Baufi24- oder Interhyp-Durchschnitt minus Topzins), auf 0,05 gerundet
- kfw308: effektiver Zins KfW 308 "Jung kauft Alt", kfw308Max: Kredithöchstbeträge nach Kinderzahl
- grest: Grunderwerbsteuer je Bundesland, NUR melden, wenn sich ein Satz gegenüber den bisherigen Werten geändert hat
- baupreis: Baupreisindex Instandhaltung Wohngebäude, Veränderung zum Vorjahr in Prozent (Destatis)
- mietpreisbremse: ein kurzer Satz zum Stand der Mietpreisbremse in Baden-Württemberg
- pfandbrief: aktuelle Umlaufsrendite von Hypothekenpfandbriefen mit 5–10 Jahren Restlaufzeit in Prozent (Bundesbank-Kapitalmarktstatistik); ersatzweise 10-jährige Bundesanleihe + 0,3

Erfinde nichts. Wenn du einen Wert nicht sicher findest, lass das Feld weg.
Antworte am Ende NUR mit einem JSON-Objekt:
{"stand":"TT.MM.JJJJ","zinsQuelle":"Quelle, Datum","zins":{"5":Zahl,"10":Zahl,"15":Zahl,"20":Zahl,"30":Zahl},"aufschlag":Zahl,"kfw308":Zahl,"kfw308Max":{"1":Zahl,"2":Zahl,"3":Zahl},"grest":{"BW":Zahl},"baupreis":Zahl,"mietpreisbremse":"…","pfandbrief":Zahl,"quellen":["url", "…"]}`;

    const tools = [{ type: "web_search_20260318", name: "web_search", max_uses: 8, allowed_domains: DOMAINS }];
    let messages = [{ role: "user", content: prompt }];
    let msg;
    for (let i = 0; i < 2; i++) {
      msg = await claude({ max_tokens: 4000, tools, messages });
      if (msg.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: msg.content }];
    }
    const d = parseJson(textOf(msg));
    if (!d) return res.status(502).json({ error: "invalid_json", message: "Keine verwertbare Antwort" });

    // Plausibilitätsprüfung: nur sinnvolle Werte übernehmen
    const next = { ...old };
    const changes = [];
    const put = (k, v, oldV) => { if (JSON.stringify(v) !== JSON.stringify(oldV)) changes.push({ feld: k, alt: oldV, neu: v }); next[k] = v; };
    if (d.zins && typeof d.zins === "object") {
      const z = { ...(old.zins || {}) };
      for (const k of ["5", "10", "15", "20", "30"]) if (inRange(d.zins[k], 0.5, 12)) z[k] = d.zins[k];
      put("zins", z, old.zins);
      if (typeof d.stand === "string" && /^\d{2}\.\d{2}\.\d{4}$/.test(d.stand)) put("stand", d.stand, old.stand);
      if (typeof d.zinsQuelle === "string") put("zinsQuelle", d.zinsQuelle.slice(0, 120), old.zinsQuelle);
    }
    if (inRange(d.aufschlag, 0, 1.5)) put("aufschlag", d.aufschlag, old.aufschlag);
    if (inRange(d.kfw308, 0, 6)) put("kfw308", d.kfw308, old.kfw308);
    if (d.kfw308Max && ["1", "2", "3"].every((k) => inRange(d.kfw308Max[k], 50000, 500000))) put("kfw308Max", d.kfw308Max, old.kfw308Max);
    if (d.grest && typeof d.grest === "object") {
      const g = { ...(old.grest || {}) };
      for (const [k, v] of Object.entries(d.grest)) if (k in g && inRange(v, 3, 7)) g[k] = v;
      put("grest", g, old.grest);
    }
    if (inRange(d.baupreis, -10, 25)) put("baupreis", d.baupreis, old.baupreis);
    if (inRange(d.pfandbrief, -1, 10)) put("pfandbrief", d.pfandbrief, old.pfandbrief);
    if (typeof d.mietpreisbremse === "string" && d.mietpreisbremse.length > 10) put("mietpreisbremse", d.mietpreisbremse.slice(0, 200), old.mietpreisbremse);
    next.quellen = Array.isArray(d.quellen) ? d.quellen.slice(0, 10) : old.quellen;
    next.geprueft = today;

    await sbAdmin("immo_market?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: "current", data: next, updated_at: new Date().toISOString() }),
    });
    return res.status(200).json({ ok: true, changes, data: next });
  } catch (e) {
    return res.status(e.code === "config" ? 500 : 502).json({ error: e.code || "upstream_error", message: e.message });
  }
}
