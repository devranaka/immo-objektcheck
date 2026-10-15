# Immo Objektcheck

Immobilien per Screenshot oder Exposé einschätzen: Sanierungskosten in drei Stufen (selbst, Mix, Firma), Raumplaner, Finanzierung mit aktuellem Zins und Auswertung für **Eigenheim**, **Fix & Flip** und **Vermieten**.

## Aufbau

| Teil | Was es macht |
|---|---|
| `index.html` | Die komplette App (Rechnen, Raumplaner, Finanzierung, Auswertung, Chat) |
| `api/ai.js` | KI-Analyse von Inseraten und KI-Berater über die Claude-API |
| `api/ort-preise.js` | Recherchiert Miet- und Kaufpreise für den Ort des Objekts (30 Tage zwischengespeichert) |
| `api/update-market.js` | Holt Zinsen, KfW-Konditionen usw. per Websuche und speichert sie in Supabase |
| `api/config.js` | Gibt der Seite die öffentlichen Supabase-Werte |
| `supabase/schema.sql` | Tabellen für gespeicherte Objekte und Marktdaten |
| `vercel.json` | Laufzeiten und automatische Aktualisierung (1. und 15. jedes Monats, 7:52 Uhr) |

Kein Build-Schritt, keine Pakete: Vercel liefert die Seite direkt aus.

## Einrichtung

### 1. Supabase
Du kannst ein **bestehendes Projekt mitbenutzen** (z. B. das vom Händler-Tool), dann kostet es nichts extra. Alle Tabellen beginnen mit `immo_` und kommen anderen Tabellen nicht in die Quere. Nutzer-Konten werden dann gemeinsam genutzt: Mit deinem bestehenden Login kannst du dich auch hier anmelden.

1. Bestehendes Projekt öffnen (oder ein neues anlegen, Region Frankfurt).
2. **SQL Editor → New query**, den Inhalt von `supabase/schema.sql` einfügen, **Run**.
3. **Project Settings → API**: notiere `Project URL`, `anon public` Key und `service_role` Key.
4. Optional: **Authentication → Providers → Email** „Confirm email“ ausschalten, dann bist du nach „Konto anlegen“ sofort angemeldet.

### 2. Claude-API-Schlüssel
Auf console.anthropic.com unter **API Keys** einen neuen Key erstellen (z. B. „immo-objektcheck“). Er nutzt dasselbe Guthaben wie deine anderen Keys; unter **Usage** siehst du die Kosten pro Key getrennt.

### 3. Vercel
1. Auf vercel.com **Add New → Project**, dieses GitHub-Repo importieren.
2. Framework Preset: **Other**. Nichts weiter einstellen.
3. Unter **Environment Variables** eintragen:

| Name | Wert |
|---|---|
| `SUPABASE_URL` | Project URL aus Supabase |
| `SUPABASE_ANON_KEY` | anon public Key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role Key (geheim!) |
| `ANTHROPIC_API_KEY` | Claude-API-Key (geheim!), gerne ein zweiter Key im selben Konto wie beim Händler-Tool |
| `ALLOWED_EMAILS` | deine E-Mail-Adresse, mehrere mit Komma getrennt |
| `CRON_SECRET` | ein beliebiges langes Passwort, z. B. 40 zufällige Zeichen |
| `AI_MODEL` | optional, Standard ist `claude-sonnet-5-5` |

4. **Deploy**. Danach die Seite öffnen, unter „Meine Objekte“ ein Konto mit der E-Mail aus `ALLOWED_EMAILS` anlegen.
5. Auf dem Handy: Seite öffnen → Teilen → „Zum Home-Bildschirm“.

**Schutz vor hohen KI-Kosten:** Jedes Konto hat Tageslimits (15 Analysen, 80 Chat-Nachrichten, 8 Ortsrecherchen, 3 Marktdaten-Aktualisierungen). Ändern per Vercel-Variable `LIMIT_ANALYZE`, `LIMIT_CHAT`, `LIMIT_ORT`, `LIMIT_MARKET`. Zusätzlich in der Claude-Konsole unter **Limits** ein Monatslimit setzen.

> `ALLOWED_EMAILS` schützt dein API-Guthaben: Nur diese Adressen dürfen die KI nutzen, auch wenn sich jemand anderes ein Konto anlegt.

## Kosten (ungefähr)
- Inserat-Analyse mit Bildern: wenige Cent
- Chat-Antwort: unter 1 Cent bis wenige Cent
- Ortspreise recherchieren: ca. 5–15 Cent pro Ort, danach 30 Tage kostenlos aus dem Zwischenspeicher
- Marktdaten-Aktualisierung: ca. 5–15 Cent pro Lauf (Websuche 1 Cent pro Suche)

## Marktdaten
Startwerte Stand 07.10.2026 (Dr. Klein Topzinsen, KfW 308 ab 3.8.2026, Grunderwerbsteuer aller Länder, DMB-Betriebskostenspiegel, Destatis-Baupreise). Die Werte werden automatisch geprüft; im Tab „Marktdaten“ gibt es zusätzlich „Jetzt aktualisieren“.

## Hinweis
Die Ergebnisse sind Schätzungen und ersetzen keine Angebote von Handwerkern, keine Bankberatung und keine Steuerberatung.
