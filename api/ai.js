// KI-Endpunkt: Inserat-Analyse (mit Bildern) und Berater-Chat.
// Nur für angemeldete Nutzer, damit niemand Fremdes dein API-Guthaben verbraucht.
import { requireUser, claude, textOf, parseJson, useQuota, limitReply } from "./_lib.js";

const MAX_IMAGES = 8;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "method", message: "Nur POST" });
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "auth", message: "Bitte anmelden." });

  const { kind, prompt, system, messages, images } = req.body || {};
  if (kind === "analyze" || kind === "chat") {
    const q = await useQuota(user, kind);
    if (!q.ok) return limitReply(res, q);
  }
  try {
    if (kind === "analyze") {
      if (typeof prompt !== "string" || !prompt) return res.status(400).json({ error: "invalid", message: "prompt fehlt" });
      const imgs = Array.isArray(images) ? images.slice(0, MAX_IMAGES) : [];
      const content = [
        ...imgs.filter((d) => typeof d === "string").map((data) => ({
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data },
        })),
        { type: "text", text: prompt.slice(0, 30000) },
      ];
      const msg = await claude({ max_tokens: 4000, messages: [{ role: "user", content }] });
      const text = textOf(msg);
      const data = parseJson(text);
      if (!data) return res.status(502).json({ error: "invalid_json", message: "Antwort war kein JSON", text });
      return res.status(200).json({ data });
    }

    if (kind === "chat") {
      if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: "invalid", message: "messages fehlt" });
      // Rollen säubern und aufeinanderfolgende gleiche Rollen zusammenführen
      const clean = [];
      for (const m of messages.slice(-16)) {
        const role = m?.role === "assistant" ? "assistant" : "user";
        const content = String(m?.content || "").slice(0, 8000);
        if (!content) continue;
        const last = clean.at(-1);
        if (last && last.role === role) last.content += "\n\n" + content;
        else clean.push({ role, content });
      }
      while (clean.length && clean[0].role !== "user") clean.shift();
      if (!clean.length || clean.at(-1).role !== "user") return res.status(400).json({ error: "invalid", message: "Letzte Nachricht muss vom Nutzer sein" });
      const msg = await claude({
        max_tokens: 2000,
        system: typeof system === "string" ? system.slice(0, 40000) : undefined,
        messages: clean,
      });
      return res.status(200).json({ text: textOf(msg) });
    }

    return res.status(400).json({ error: "invalid", message: "Unbekannter Typ" });
  } catch (e) {
    const status = e.code === "rate_limited" ? 429 : e.code === "config" ? 500 : 502;
    return res.status(status).json({ error: e.code || "upstream_error", message: e.message });
  }
}
