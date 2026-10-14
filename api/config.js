// Liefert der Seite die öffentlichen Supabase-Werte (URL + Anon-Key). Beide sind für den Browser gedacht.
export default function handler(req, res) {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.status(200).json({
    url: process.env.SUPABASE_URL || "",
    anon: process.env.SUPABASE_ANON_KEY || "",
  });
}
