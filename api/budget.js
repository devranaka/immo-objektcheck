// Zeigt, wie viel vom KI-Budget in diesem Monat schon verbraucht ist.
import { requireUser, spentThisMonth, budgetInfo, estimateMilli } from "./_lib.js";

export default async function handler(req, res) {
  const user = await requireUser(req);
  if (!user) return res.status(401).json({ error: "auth", message: "Bitte anmelden." });
  const B = budgetInfo();
  try {
    const sp = await spentThisMonth(user.id);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      totalEur: sp.total / 1000, budgetEur: B.total / 1000, mineEur: sp.mine / 1000, userBudgetEur: B.user / 1000,
      maxEur: { analyze: estimateMilli("analyze") / 1000, chat: estimateMilli("chat") / 1000, ort: estimateMilli("ort") / 1000, bewertung: estimateMilli("bewertung") / 1000 },
    });
  } catch (e) {
    return res.status(503).json({ error: "budget_setup", message: "Der Kostenschutz ist noch nicht eingerichtet. Bitte supabase/schema.sql in Supabase ausführen." });
  }
}
