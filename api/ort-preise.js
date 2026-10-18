// Recherchiert per Claude + Websuche die aktuellen Kauf- und Mietpreise für einen bestimmten Ort.
// Ergebnisse werden 30 Tage in Supabase (Tabelle immo_market, id "ort:…") zwischengespeichert,
// damit derselbe Ort nicht jedes Mal neu bezahlt werden muss.
import { requireUser, claude, finalText, allText, parseJsonLoose, sbAdmin, useQuota, limitReply, reserveBudget, settleBudget, budgetReply } from "./_lib.js";

const CACHE_TAGE = 30;
const inRange = (v, lo, hi) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
const slug = (s) => String(s || "").toLowerCase()
  .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "auth", message: "Bitte anmelden." });

  const { ort, typ, baujahr, wfl, zimmer, force } = req.body || {};
  if (!ort || String(ort).trim().length < 2) return res.status(400).json({ error: "invalid", message: "Ort fehlt" });
  const art = typ === "wohnung" ? "wohnung" : "haus";
  const id = `ort:${slug(ort)}:${art}`;

  let bud = null; const track = [];
  try {
    if (!force) {
      const rows = await sbAdmin(`immo_market?id=eq.${encodeURIComponent(id)}&select=data,updated_at`).catch(() => null);
      const hit = rows?.[0];
      if (hit && Date.now() - new Date(hit.updated_at).getTime() < CACHE_TAGE * 864e5) {
        return res.status(200).json({ data: hit.data, cached: true });
      }
    }
    // Erst ab hier kostet es Geld: Tageslimit prüfen
    const q = await useQuota(user, "ort");
    if (!q.ok) return limitReply(res, q);
    bud = await reserveBudget(user, "ort");
    if (!bud.ok) return budgetReply(res, bud);

    const heute = new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
    const prompt = `Heute ist der ${heute}. Recherchiere mit der Websuche die aktuellen Immobilienpreise für GENAU diesen Ort: "${ort}".
Objekt: ${art === "wohnung" ? "Eigentumswohnung" : "Haus"}${baujahr ? `, Baujahr ${baujahr}` : ""}${wfl ? `, ${wfl} m²` : ""}${zimmer ? `, ${zimmer} Zimmer` : ""}.

Gesucht (für diesen Ort, nicht für die nächste Großstadt oder den Landkreis, außer es gibt keine Ortsdaten – dann sag das in "hinweis"):
1. Nettokaltmiete in €/m² bei Neuvermietung: einfache, mittlere und gute Lage, und ein Wert "normal" passend zu Baujahr und Größe dieses Objekts (Ausstattung normal).
2. Gibt es einen qualifizierten oder einfachen Mietspiegel (Jahr)? Ortsübliche Vergleichsmiete für so ein Objekt, falls auffindbar.
3. Kaufpreise in €/m² für ${art === "wohnung" ? "Eigentumswohnungen" : "Häuser"}: Durchschnitt, typischer Preis für ein unsaniertes Objekt dieses Baujahrs und für ein saniertes/neuwertiges.
4. Gilt dort die Mietpreisbremse?

Gute Quellen: immoportal.com, wohnungsboerse.net, immowelt.de, immobilienscout24.de, homeday.de, mietspiegeltabelle.de, die Website der Stadt (Mietspiegel-PDF), Gutachterausschuss.
Erfinde nichts. Unsichere Werte lieber weglassen (null).

Antworte am Ende NUR mit einem JSON-Objekt:
{"ort":"Name des Orts","miete_qm":{"einfach":Zahl,"mittel":Zahl,"gut":Zahl},"miete_qm_normal":Zahl,"vergleichsmiete_qm":Zahl|null,"mietspiegel":"z. B. Qualifizierter Mietspiegel 2025"|null,"mietpreisbremse":true|false|null,"kaufpreis_qm":Zahl,"kaufpreis_qm_unsaniert":Zahl,"kaufpreis_qm_saniert":Zahl,"stand":"Monat Jahr der Daten","hinweis":"1 Satz zur Datenlage","quellen":[{"titel":"…","url":"https://…"}]}`;

    const tools = [{ type: "web_search_20260318", name: "web_search", max_uses: 5 }];
    let messages = [{ role: "user", content: prompt }];
    let msg;
    for (let i = 0; i < 2; i++) {
      msg = await claude({ max_tokens: 3000, tools, messages }, track);
      if (msg.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: msg.content }];
    }
    const d = parseJsonLoose(finalText(msg)) || parseJsonLoose(allText(track));
    if (!d) return res.status(502).json({ error: "invalid_json", message: "Keine verwertbare Antwort" });

    // Plausibilität prüfen
    const out = {
      ort: String(d.ort || ort).slice(0, 80),
      art,
      miete_qm: {},
      miete_qm_normal: inRange(d.miete_qm_normal, 3, 45) ? d.miete_qm_normal : null,
      vergleichsmiete_qm: inRange(d.vergleichsmiete_qm, 3, 45) ? d.vergleichsmiete_qm : null,
      mietspiegel: typeof d.mietspiegel === "string" ? d.mietspiegel.slice(0, 120) : null,
      mietpreisbremse: typeof d.mietpreisbremse === "boolean" ? d.mietpreisbremse : null,
      kaufpreis_qm: inRange(d.kaufpreis_qm, 300, 25000) ? d.kaufpreis_qm : null,
      kaufpreis_qm_unsaniert: inRange(d.kaufpreis_qm_unsaniert, 300, 25000) ? d.kaufpreis_qm_unsaniert : null,
      kaufpreis_qm_saniert: inRange(d.kaufpreis_qm_saniert, 300, 30000) ? d.kaufpreis_qm_saniert : null,
      stand: typeof d.stand === "string" ? d.stand.slice(0, 40) : heute,
      hinweis: typeof d.hinweis === "string" ? d.hinweis.slice(0, 300) : "",
      quellen: Array.isArray(d.quellen)
        ? d.quellen.filter((q) => q && /^https?:\/\//.test(q.url)).slice(0, 6).map((q) => ({ titel: String(q.titel || q.url).slice(0, 100), url: q.url }))
        : [],
      recherchiert: heute,
    };
    for (const k of ["einfach", "mittel", "gut"]) if (inRange(d.miete_qm?.[k], 3, 45)) out.miete_qm[k] = d.miete_qm[k];
    if (!out.miete_qm_normal && out.miete_qm.mittel) out.miete_qm_normal = out.miete_qm.mittel;

    // Speichern darf das Ergebnis nicht verhindern: die Recherche ist schon bezahlt
    try {
      await sbAdmin("immo_market?on_conflict=id", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ id, data: out, updated_at: new Date().toISOString() }),
      });
    } catch (e) { console.error("Ortspreise konnten nicht zwischengespeichert werden:", e.message); }
    return res.status(200).json({ data: out, cached: false });
  } catch (e) {
    const status = e.code === "rate_limited" ? 429 : e.code === "config" ? 500 : 502;
    return res.status(status).json({ error: e.code || "upstream_error", message: e.message });
  } finally {
    if (bud?.ok) await settleBudget(bud, track);
  }
}
