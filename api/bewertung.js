// Wertermittlung einer eigenen Immobilie: Fragebogen + Fotos/Energieausweis + Websuche nach Vergleichsobjekten.
// Ergebnis: Marktwert mit Spanne, Vergleichsobjekte mit Links, Zu- und Abschläge, Angebots- und Schnellverkaufspreis.
import { requireUser, claude, finalText, allText, parseJsonLoose, useQuota, limitReply, reserveBudget, settleBudget, budgetReply } from "./_lib.js";

const MAX_IMAGES = 10;
const SCHEMA = `{"marktwert":Zahl,"spanne":{"min":Zahl,"max":Zahl},"preis_qm":Zahl,"angebotspreis":Zahl,"schnellverkauf":Zahl,
"sicherheit":"hoch|mittel|niedrig","sicherheit_grund":"1 Satz",
"methoden":[{"name":"Vergleichswert","wert":Zahl,"erklaerung":"1-2 Sätze"}],
"markt":{"ort":"…","kauf_qm_durchschnitt":Zahl,"kauf_qm_min":Zahl,"kauf_qm_max":Zahl,"miete_qm":Zahl|null,"bodenrichtwert":Zahl|null,"trend":"1 Satz zur Preisentwicklung","stand":"Monat Jahr"},
"vergleichsobjekte":[{"titel":"…","wfl":Zahl,"baujahr":Zahl|null,"preis":Zahl,"preis_qm":Zahl,"art":"Angebot|Verkauf|Statistik","url":"https://…"}],
"anpassungen":[{"faktor":"z. B. Balkon Südwest","prozent":Zahl,"grund":"kurz"}],
"aus_bildern":["was du aus Fotos/Energieausweis/Grundriss erkannt hast"],
"staerken":["…"],"schwaechen":["…"],"tipps_wertsteigerung":["konkrete Tipps vor dem Verkauf mit grober Kosten-Nutzen-Angabe"],
"fazit":"3-4 Sätze für den Eigentümer, verständlich"}`;
const inRange = (v, lo, hi) => typeof v === "number" && isFinite(v) && v >= lo && v <= hi;
const str = (v, n = 300) => (typeof v === "string" ? v.slice(0, n) : "");
const list = (a, n = 8, len = 240) => (Array.isArray(a) ? a.filter((x) => typeof x === "string").slice(0, n).map((x) => x.slice(0, len)) : []);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "auth", message: "Bitte anmelden." });

  const { daten, ortInfo, images } = req.body || {};
  if (!daten || typeof daten !== "object") return res.status(400).json({ error: "invalid", message: "Fragebogen fehlt" });
  if (!String(daten.ort || "").trim()) return res.status(400).json({ error: "invalid", message: "Ort fehlt" });

  const q = await useQuota(user, "bewertung");
  if (!q.ok) return limitReply(res, q);
  const bud = await reserveBudget(user, "bewertung");
  if (!bud.ok) return budgetReply(res, bud);
  const track = [];

  const heute = new Date().toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
  const imgs = Array.isArray(images) ? images.filter((d) => typeof d === "string").slice(0, MAX_IMAGES) : [];

  const prompt = `Heute ist der ${heute}. Du bist ein erfahrener Immobiliengutachter in Deutschland. Ermittle den aktuellen Marktwert (Verkehrswert im Sinne eines realistischen Verkaufspreises) dieser Immobilie so genau wie möglich.

FRAGEBOGEN DES EIGENTÜMERS (JSON, leere Felder = unbekannt):
${JSON.stringify(daten).slice(0, 20000)}
${ortInfo ? `\nBEREITS RECHERCHIERTE ORTSPREISE (zur Orientierung, selbst prüfen):\n${JSON.stringify(ortInfo).slice(0, 3000)}\n` : ""}
${imgs.length ? `Dazu ${imgs.length} Bilder des Eigentümers: Fotos der Immobilie und eventuell Energieausweis, Grundriss oder Unterlagen. Lies Daten aus Energieausweis und Grundriss aus und beurteile Zustand und Ausstattung auf den Fotos.\n` : ""}
VORGEHEN:
1. Suche mit der Websuche nach aktuellen Kaufpreisen pro m² für genau diesen Ort (möglichst Stadtteil/PLZ) und diese Objektart, Baujahresklasse und Größe. Gute Quellen: immoportal.com, immowelt.de, immobilienscout24.de, homeday.de, wohnungsboerse.net, Gutachterausschuss/Grundstücksmarktbericht, BORIS (Bodenrichtwerte).
2. Suche konkrete Vergleichsangebote (gleicher Ort, ähnliche Größe, Baujahr, Zustand). Angebotspreise liegen meist 5–10 % über echten Verkaufspreisen, ziehe das ab.
3. Vergleichswertverfahren als Hauptmethode. Bei Häusern zusätzlich Bodenwert (Bodenrichtwert × Grundstück) plus Gebäudewert als Plausibilität. Bei vermieteten Objekten oder Mehrfamilienhäusern zusätzlich Ertragswert über Jahresnettokaltmiete × marktüblichen Vervielfältiger.
4. Bewerte jedes Merkmal mit Zu- oder Abschlag in Prozent: Lage im Ort, Etage/Aufzug, Balkon/Garten/Ausrichtung, Stellplatz, Zustand und Modernisierungen (mit Jahr), Ausstattung, Energieklasse und Heizung, Hausgeld/Rücklage/Sonderumlagen, Vermietung, Rechte und Lasten, Besonderheiten aus dem Freitext und den Fotos.
5. Leite daraus einen Marktwert und eine realistische Spanne ab, sowie einen Angebotspreis für Inserate und einen Preis für einen schnellen Verkauf (ca. 4–8 Wochen).
Sei ehrlich und eher vorsichtig, Eigentümer überschätzen ihre Immobilie oft. Erfinde keine Vergleichsobjekte: nur, was du wirklich gefunden hast, mit URL.

Antworte am Ende NUR mit einem JSON-Objekt:
${SCHEMA}`;

  const content = [
    ...imgs.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
    { type: "text", text: prompt },
  ];
  const tools = [{ type: "web_search_20260318", name: "web_search", max_uses: 8 }];
  const model = process.env.AI_MODEL_BEWERTUNG || undefined;

  try {
    let messages = [{ role: "user", content }];
    let msg;
    for (let i = 0; i < 3; i++) {
      msg = await claude({ max_tokens: 8000, tools, messages, ...(model ? { model } : {}) }, track);
      if (msg.stop_reason !== "pause_turn") break;
      messages = [...messages, { role: "assistant", content: msg.content }];
    }
    const ok = (o) => o && inRange(o.marktwert, 10000, 50000000);
    let d = parseJsonLoose(finalText(msg));
    if (!ok(d)) d = parseJsonLoose(allText(track));
    if (!ok(d)) {
      // Rettung: den bisherigen Text ohne Websuche in das JSON-Format umwandeln lassen (kostet wenige Cent)
      const raw = allText(track).slice(-60000);
      console.error("Bewertung: JSON nicht lesbar, stop_reason=", msg?.stop_reason, "Textanfang:", raw.slice(0, 1500));
      if (raw.trim()) {
        const fix = await claude({ max_tokens: 6000, messages: [{ role: "user", content:
          `Unten steht eine Immobilienbewertung als Text. Gib sie als genau dieses JSON aus, ohne jeden weiteren Text. Erfinde nichts, fehlende Werte sind null. Zahlen ohne Tausenderpunkte.\n\nFORMAT:\n${SCHEMA}\n\nTEXT:\n${raw}` }] }, track);
        d = parseJsonLoose(finalText(fix));
      }
    }
    if (!ok(d)) {
      console.error("Bewertung endgültig nicht lesbar:", allText(track).slice(-3000));
      return res.status(502).json({ error: "invalid_json", message: msg?.stop_reason === "max_tokens"
        ? "Die Bewertung wurde zu lang und abgeschnitten. Bitte nochmal versuchen, eventuell mit weniger Bildern."
        : "Die KI hat keinen Wert geliefert. Bitte nochmal versuchen. Tipp: Ort und Postleitzahl prüfen." });
    }
    const mw = d.marktwert;
    const near = (v) => (inRange(v, mw * 0.5, mw * 1.6) ? v : null);
    const out = {
      marktwert: mw,
      spanne: { min: near(d.spanne?.min) ?? Math.round(mw * 0.92), max: near(d.spanne?.max) ?? Math.round(mw * 1.08) },
      preis_qm: inRange(d.preis_qm, 100, 40000) ? d.preis_qm : null,
      angebotspreis: near(d.angebotspreis) ?? Math.round(mw * 1.05),
      schnellverkauf: near(d.schnellverkauf) ?? Math.round(mw * 0.93),
      sicherheit: ["hoch", "mittel", "niedrig"].includes(d.sicherheit) ? d.sicherheit : "mittel",
      sicherheit_grund: str(d.sicherheit_grund),
      methoden: Array.isArray(d.methoden)
        ? d.methoden.filter((m) => m && inRange(m.wert, 1000, 60000000)).slice(0, 4).map((m) => ({ name: str(m.name, 60), wert: m.wert, erklaerung: str(m.erklaerung, 400) }))
        : [],
      markt: d.markt && typeof d.markt === "object" ? {
        ort: str(d.markt.ort, 80),
        kauf_qm_durchschnitt: inRange(d.markt.kauf_qm_durchschnitt, 100, 40000) ? d.markt.kauf_qm_durchschnitt : null,
        kauf_qm_min: inRange(d.markt.kauf_qm_min, 100, 40000) ? d.markt.kauf_qm_min : null,
        kauf_qm_max: inRange(d.markt.kauf_qm_max, 100, 40000) ? d.markt.kauf_qm_max : null,
        miete_qm: inRange(d.markt.miete_qm, 2, 60) ? d.markt.miete_qm : null,
        bodenrichtwert: inRange(d.markt.bodenrichtwert, 5, 20000) ? d.markt.bodenrichtwert : null,
        trend: str(d.markt.trend), stand: str(d.markt.stand, 40),
      } : null,
      vergleichsobjekte: Array.isArray(d.vergleichsobjekte)
        ? d.vergleichsobjekte.filter((v) => v && /^https?:\/\//.test(v.url || "") && inRange(v.preis, 1000, 60000000)).slice(0, 10).map((v) => ({
            titel: str(v.titel, 120), wfl: inRange(v.wfl, 5, 5000) ? v.wfl : null, baujahr: inRange(v.baujahr, 1500, 2100) ? v.baujahr : null,
            preis: v.preis, preis_qm: inRange(v.preis_qm, 100, 40000) ? v.preis_qm : null, art: str(v.art, 20), url: v.url,
          }))
        : [],
      anpassungen: Array.isArray(d.anpassungen)
        ? d.anpassungen.filter((a) => a && inRange(a.prozent, -50, 50)).slice(0, 16).map((a) => ({ faktor: str(a.faktor, 80), prozent: a.prozent, grund: str(a.grund, 200) }))
        : [],
      aus_bildern: list(d.aus_bildern),
      staerken: list(d.staerken), schwaechen: list(d.schwaechen), tipps_wertsteigerung: list(d.tipps_wertsteigerung, 8, 300),
      fazit: str(d.fazit, 900),
      erstellt: heute,
    };
    return res.status(200).json({ data: out });
  } catch (e) {
    const status = e.code === "rate_limited" ? 429 : e.code === "config" ? 500 : 502;
    return res.status(status).json({ error: e.code || "upstream_error", message: e.message });
  } finally {
    await settleBudget(bud, track);
  }
}
