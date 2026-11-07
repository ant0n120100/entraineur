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

app.listen(process.env.PORT || 3000, () => console.log("Coach matin prêt"));
