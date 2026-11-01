require('dotenv').config();

const express = require('express');
const { auth, requiresAuth } = require('express-openid-connect');
const { auth: jwtCheck, requiredScopes } = require('express-oauth2-jwt-bearer');
const { Pool } = require('pg');
const QRCode = require('qrcode');
const { randomUUID } = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE_URL = process.env.BASE_URL;
const PORT = process.env.PORT || 3000;

// connection to db  
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

// init app
const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// escape characters
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// return page with custom body
const page = (title, body) => `<!doctype html>
<html lang="hr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;line-height:1.5}
  table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:.4rem;text-align:left}
  .ACTIVE{color:#0a7d2c;font-weight:bold} .CANCELLED{color:#b00020;font-weight:bold}
  form{display:inline} button{cursor:pointer}
</style></head><body>${body}</body></html>`;

// test if correct uuid format
const isUuid = (id) => UUID_RE.test(id);

// ---- OIDC params ----
app.use(
  auth({
    authRequired: false, // set to true to require authentication for all routes
    auth0Logout: true,
    secret: process.env.SESSION_SECRET,
    baseURL: process.env.BASE_URL,
    clientID: process.env.CLIENT_ID,
    issuerBaseURL: process.env.ISSUER_BASE_URL,

    clientSecret: process.env.CLIENT_SECRET,
    authorizationParams: { response_type: 'code', scope: 'openid profile email' },
  })
);

// ---- M2M params ----
const checkJwt = jwtCheck({
  issuerBaseURL: process.env.ISSUER_BASE_URL,
  audience: process.env.AUDIENCE,
  tokenSigningAlg: 'RS256'

});

// ---- endpoints ----
app.get('/', async (req, res, next) => {
  try {

    // get passes from db
    const { rows: [c] } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active
       FROM passes`
    );
    let body = `<h1>Digitalne propusnice</h1>
      <p>Ukupno propusnica: <b>${c.total}</b></p>
      <p>Aktivnih propusnica: <b>${c.active}</b></p>`;

    // redirect to login if not logged in
    if (!req.oidc.isAuthenticated()) {
      body += `<p><a href="/login">Prijava</a></p>`;
    }

    // main page
    else {
      const u = req.oidc.user;
      body += `<p>Prijavljeni korisnik: ${esc(u.email || u.name || u.sub)} &middot; <a href="/logout">Odjava</a></p>`;
      const { rows } = await pool.query('SELECT * FROM passes ORDER BY issued_at DESC');
      body += `<h2>Propusnice</h2>`;
      if (!rows.length) {
        body += `<p>Nema propusnica.</p>`;
      } else {
        body += `<table><tr><th>ID</th><th>Ime i prezime</th><th>Dokument</th><th>Izdana</th><th>Status</th><th>Akcije</th></tr>`;
        for (const p of rows) {
          body += `<tr>
            <td><a href="/info/${p.id}">${p.id}</a></td>
            <td>${esc(p.name)}</td>
            <td>${esc(p.document)}</td>
            <td>${p.issued_at.toISOString()}</td>
            <td class="${p.status}">${p.status}</td>
            <td>
              ${p.status === 'ACTIVE' ? `<form method="post" action="/passes/${p.id}/cancel"><button>Poništi</button></form>` : ''}
              <form method="post" action="/passes/${p.id}/delete" onsubmit="return confirm('Obrisati propusnicu?')"><button>Obriši</button></form>
            </td></tr>`;
        }
        body += `</table>`;
      }
    }

    res.send(page('Propusnice', body));
  } catch (e) {
    next(e);
  }
});

// page with qr code
app.get('/info/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    // get pass 
    const { rows } = isUuid(id) ? await pool.query('SELECT * FROM passes WHERE id = $1', [id]) : { rows: [] };
    if (!rows.length) {
      return res.status(404).send(page('Nije pronađeno', '<h1>404</h1><p>Propusnica ne postoji.</p>'));
    }
    const p = rows[0];

    res.send(
      page(
        'Propusnica',
        `<h1>Propusnica</h1>
         <p>Status: <span class="${p.status}">${p.status}</span></p>
         <p>Ime i prezime: <b>${esc(p.name)}</b></p>
         <p>Oznaka dokumenta: <b>${esc(p.document)}</b></p>
         <p>Vrijeme izdavanja: <b>${p.issued_at.toISOString()}</b></p>`
      )
    );
  } catch (e) {
    next(e);
  }
});

// deactivate pass
app.post('/passes/:id/cancel', requiresAuth(), async (req, res, next) => {
  try {
    if (isUuid(req.params.id)) {
      await pool.query(`UPDATE passes SET status = 'CANCELLED' WHERE id = $1`, [req.params.id]);
    }
    res.redirect('/');
  } catch (e) {
    next(e);
  }
});

// delete pass
app.post('/passes/:id/delete', requiresAuth(), async (req, res, next) => {
  try {
    if (isUuid(req.params.id)) {
      await pool.query('DELETE FROM passes WHERE id = $1', [req.params.id]);
    }
    res.redirect('/');
  } catch (e) {
    next(e);
  }
});

// ---- M2M ----
// get passes 
app.get('/passes/:id', checkJwt, requiredScopes('read:passes'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const { rows } = isUuid(id) ? await pool.query('SELECT * FROM passes WHERE id = $1', [id]) : { rows: [] };

    if (!rows.length) return res.status(404).json({ error: 'Pass not found' });

    const p = rows[0];
    res.json({
      id: p.id,
      name: p.name,
      document: p.document,
      issuedAt: p.issued_at.toISOString(),
      status: p.status,
    });
  } catch (e) {
    next(e);
  }
});

// create new pass
app.post('/passes', checkJwt, requiredScopes('create:passes'), async (req, res, next) => {
  try {
    const { name, document } = req.body || {};
    if (typeof name !== 'string' || typeof document !== 'string' || !name.trim() || !document.trim()) {
      return res.status(400).json({ error: 'name and document are required' });
    }
    const id = randomUUID();
    await pool.query('INSERT INTO passes (id, name, document, issued_at, status) VALUES ($1, $2, $3, now(), $4)', [
      id,
      name.trim(),
      document.trim(),
      'ACTIVE',
    ]);

    // QR points to url
    const png = await QRCode.toBuffer(`${BASE_URL}/info/${id}`, { type: 'png', width: 400, margin: 2 });
    res.status(201).set('Location', `${BASE_URL}/passes/${id}`).type('image/png').send(png);
  } catch (e) {
    next(e);
  }
});

// catch erros
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  if (err.headers) res.set(err.headers); // WWW-Authenticate za 401/403
  res.status(status).json({ error: status >= 500 ? 'Internal Server Error' : err.message });
});

// 
(async () => {
  // create table on init
  await pool.query(`
    CREATE TABLE IF NOT EXISTS passes (
      id        UUID PRIMARY KEY,
      name      TEXT NOT NULL,
      document  TEXT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      status    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CANCELLED'))
    )`);

  // init app
  app.listen(PORT, () => console.log(`Listening on ${PORT}, base URL ${BASE_URL}`));
})().catch((e) => {
  console.error('Startup failed', e);
  process.exit(1);
});