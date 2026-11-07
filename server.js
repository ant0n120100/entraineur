const express = require("express");
const cookieSession = require("cookie-session");
const { STRAVA_CLIENT_ID: ID, STRAVA_CLIENT_SECRET: SEC, SESSION_SECRET, BASE_URL = "http://localhost:3000" } = process.env;

const app = express();
app.set("trust proxy", 1);
app.use(cookieSession({
  name: "s", keys: [SESSION_SECRET || "dev-secret"], maxAge: 30 * 864e5,
  httpOnly: true, sameSite: "lax", secure: BASE_URL.startsWith("https")
}));
app.use(express.static("public"));
app.use(express.json({ limit: "50kb" }));

async function token(body) {
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: ID, client_secret: SEC, ...body })
  });
  if (!r.ok) throw new Error("token " + r.status);
  return r.json();
}

app.get("/auth/login", (req, res) => {
  req.session.state = Math.random().toString(36).slice(2) + Date.now().toString(36);
  res.redirect("https://www.strava.com/oauth/authorize?" + new URLSearchParams({
    client_id: ID, redirect_uri: BASE_URL + "/auth/callback", response_type: "code",
    approval_prompt: "auto", scope: "read,activity:read_all,profile:read_all", state: req.session.state
  }));
});

app.get("/auth/callback", async (req, res) => {
  try {
    if (!req.query.code || req.query.state !== req.session.state) return res.status(400).send("Connexion refusée.");
    const t = await token({ code: req.query.code, grant_type: "authorization_code" });
    req.session = { at: t.access_token, rt: t.refresh_token, exp: t.expires_at };
    res.redirect("/");
  } catch (e) { res.status(500).send("Erreur Strava."); }
});

app.get("/auth/logout", (req, res) => { req.session = null; res.redirect("/"); });

async function api(req, path) {
  const s = req.session;
  if (!s || !s.rt) throw Object.assign(new Error("auth"), { code: 401 });
  if (s.exp < Date.now() / 1000 + 60) {
    const t = await token({ grant_type: "refresh_token", refresh_token: s.rt });
    s.at = t.access_token; s.rt = t.refresh_token; s.exp = t.expires_at;
  }
  const r = await fetch("https://www.strava.com/api/v3" + path, { headers: { Authorization: "Bearer " + s.at } });
  if (!r.ok) throw Object.assign(new Error("strava"), { code: r.status });
  return r.json();
}

app.get("/api/data", async (req, res) => {
  try {
    const after = Math.floor(Date.now() / 1000) - 60 * 86400;
    const [me, acts] = await Promise.all([
      api(req, "/athlete"),
      api(req, "/athlete/activities?per_page=100&after=" + after)
    ]);
    res.json({
      name: me.firstname || "",
      ftp: me.ftp || null,
      acts: acts.map(a => ({
        t: a.start_date_local, sport: a.sport_type || a.type, name: a.name,
        sec: a.moving_time, km: Math.round((a.distance || 0) / 100) / 10,
        w: a.weighted_average_watts || a.average_watts || null, dev: !!a.device_watts
      }))
    });
  } catch (e) {
    res.status(e.code === 401 ? 401 : 502).json({ error: e.message });
  }
});

const SYSTEM = `Tu es l'entraîneur personnel d'un jeune triathlète de 15 ans (vélo, course à pied, athlétisme). Tu parles français, tutoies, réponds court et concret.
Contexte fixe : home-trainer Bkool sur MyWhoosh, vélo de route. Créneau vélo strict 6h00-7h00, 58 min maximum tout compris, il descend à 7h00 pour le bus. Entraînements à côté : mercredi, et vendredi une semaine sur deux (sinon mardi). Objectif : progresser en vélo pour des courses au printemps (CLM ou peloton), en restant complémentaire avec l'athlétisme. Il veut des séances structurées, jamais "pédaler librement".
Règles :
- Avant de valider une séance, demande l'état de forme du matin (sommeil en heures, jambes sur 10, douleurs) s'il ne l'a pas donné.
- Utilise les données Strava fournies (FTP, forme CTL, fatigue ATL, fraîcheur TSB, activités récentes) pour adapter. Dis ce que tu constates en une phrase.
- Format d'une séance : Échauffement / Corps de séance / Retour au calme, avec durées en minutes et cibles en watts calculées sur le FTP (jamais de FC : pas de ceinture). Vérifie que le total ne dépasse pas 58 min.
- Maximum 2 séances intenses par semaine, jamais le matin d'un entraînement du mercredi ou vendredi. Si fatigue élevée, jambes lourdes ou sommeil court : séance facile ou repos.
- Le FTP vient d'une estimation du home-trainer, il est peu fiable : propose un test rampe MyWhoosh si pertinent.
- Si douleur persistante, malaise ou fatigue anormale : conseille d'arrêter et d'en parler à un parent ou à un médecin.
- Ne dis pas que tu as des données que tu n'as pas. Pas de longs discours.`;

app.post("/api/coach", async (req, res) => {
  if (!req.session || !req.session.rt) return res.status(401).json({ error: "auth" });
  const { messages = [], ctx = {} } = req.body || {};
  const msgs = messages.slice(-12).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content || "").slice(0, 2000)
  }));
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "bad" });
  const system = SYSTEM + "\n\nDonnées Strava de l'athlète :\n" + JSON.stringify(ctx).slice(0, 4000);
  const A = process.env.ANTHROPIC_API_KEY, G = process.env.GROQ_API_KEY;
  try {
    let r, j, text;
    if (A) {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": A, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 900, system, messages: msgs })
      });
      j = await r.json();
      text = r.ok && j.content ? j.content.map(b => b.text || "").join("") : null;
    } else if (G) {
      r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer " + G, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", max_tokens: 900, messages: [{ role: "system", content: system }, ...msgs] })
      });
      j = await r.json();
      text = r.ok && j.choices ? j.choices[0].message.content : null;
    } else return res.status(503).json({ error: "no_key" });
    if (!text) {
      console.error("LLM erreur", r.status, JSON.stringify(j).slice(0, 500));
      return res.status(502).json({ error: "llm", status: r.status });
    }
    res.json({ text });
  } catch (e) { console.error("LLM exception", e.message); res.status(502).json({ error: "llm" }); }
});

app.listen(process.env.PORT || 3000, () => console.log("Coach matin prêt"));
