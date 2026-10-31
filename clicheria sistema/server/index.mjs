import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomInt, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const dataDir = resolve(process.env.OPTRACK_DATA_DIR || join(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'optrack.sqlite'));
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
const storageDriver = process.env.OPTRACK_STORAGE_DRIVER || (process.env.NODE_ENV === 'production' ? 'supabase' : 'local');
const privateFilesDir = join(dataDir, 'private-attachments');
if (storageDriver === 'local') mkdirSync(privateFilesDir, { recursive: true, mode: 0o700 });
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseStorageKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseBucket = clean(process.env.OPTRACK_STORAGE_BUCKET || 'optrack-private', 100);
const turnstileSiteKey = process.env.TURNSTILE_SITE_KEY || '';
const turnstileSecretKey = process.env.TURNSTILE_SECRET_KEY || '';
const turnstileTestPair = turnstileSiteKey === '1x00000000000000000000AA' && turnstileSecretKey === '1x0000000000000000000000000000000AA';
const resendApiKey = process.env.RESEND_API_KEY || '';
const emailFrom = process.env.OPTRACK_EMAIL_FROM || '';

const STATUSES = ['Pedido criado', 'Em produção', 'Saiu para entrega', 'Entregue ao destino'];
const scryptAsync = promisify(scrypt);
const limits = new Map();
const maxLimitEntries = 4096;
let nextLimitCleanup = 0;
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'operator', 'viewer')),
    active INTEGER NOT NULL DEFAULT 1,
    account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('pending','active','inactive')),
    removed_at TEXT,
    email_verified_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sequences (
    year INTEGER PRIMARY KEY,
    next_value INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    number TEXT NOT NULL UNIQUE,
    customer_name TEXT NOT NULL,
    customer_email TEXT,
    customer_phone TEXT,
    customer_company TEXT,
    product TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1,
    destination TEXT,
    due_date TEXT,
    internal_notes TEXT,
    status TEXT NOT NULL CHECK(status IN ('Pedido criado', 'Em produção', 'Saiu para entrega', 'Entregue ao destino')),
    tracking_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    updated_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id),
    assigned_to TEXT REFERENCES users(id),
    pending_reason TEXT,
    next_action_date TEXT,
    artwork_status TEXT NOT NULL DEFAULT 'not_required' CHECK(artwork_status IN ('not_required','pending','approved','changes_requested')),
    artwork_note TEXT,
    artwork_reviewed_by TEXT REFERENCES users(id),
    artwork_reviewed_at TEXT,
    delivery_mode TEXT CHECK(delivery_mode IS NULL OR delivery_mode IN ('own_fleet','carrier','customer_pickup')),
    carrier_name TEXT,
    driver_name TEXT,
    driver_phone TEXT,
    delivery_forecast TEXT,
    tracking_code TEXT,
    tracking_url TEXT,
    departed_at TEXT,
    departed_by TEXT REFERENCES users(id),
    delivered_at TEXT,
    delivered_by TEXT REFERENCES users(id),
    received_by TEXT
  );
  CREATE TABLE IF NOT EXISTS order_events (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    note TEXT,
    kind TEXT NOT NULL DEFAULT 'status',
    summary TEXT,
    details_json TEXT,
    actor_id TEXT NOT NULL REFERENCES users(id),
    actor_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_order_created ON order_events(order_id, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_events_created ON order_events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS order_attachments (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    category TEXT NOT NULL CHECK(category IN ('artwork','approval','delivery_proof','other')),
    original_name TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    customer_visible INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    uploaded_by_name TEXT NOT NULL,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_order ON order_attachments(order_id, uploaded_at DESC);
`);

// Lightweight additive migrations keep local installations and future upgrades compatible.
const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
const userSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get()?.sql || '';
if (!userSchema.includes("'viewer'") || !userSchema.includes("'owner'")) {
  const userAccountStatusProjection = columns('users').has('account_status') ? 'account_status' : "CASE WHEN active=1 THEN 'active' ELSE 'inactive' END";
  const userRemovedAtProjection = columns('users').has('removed_at') ? 'removed_at' : 'NULL';
  const userEmailVerifiedProjection = columns('users').has('email_verified_at') ? 'email_verified_at' : "CASE WHEN active=1 OR role IN ('owner','admin') THEN created_at ELSE NULL END";
  db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
    CREATE TABLE users_next (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'operator', 'viewer')),
      active INTEGER NOT NULL DEFAULT 1,
      account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('pending','active','inactive')),
      removed_at TEXT,
      email_verified_at TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO users_next SELECT id,name,email,password_hash,role,active,${userAccountStatusProjection},${userRemovedAtProjection},${userEmailVerifiedProjection},created_at FROM users;
    DROP TABLE users;
    ALTER TABLE users_next RENAME TO users;
    COMMIT; PRAGMA foreign_keys=ON;`);
}
if (!db.prepare("SELECT id FROM users WHERE role='owner' LIMIT 1").get()) {
  const legacyOwner = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1 ORDER BY created_at ASC LIMIT 1").get();
  if (legacyOwner) db.prepare("UPDATE users SET role='owner' WHERE id=?").run(legacyOwner.id);
}
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_owner ON users(role) WHERE role='owner'");
if (!columns('users').has('account_status')) {
  db.exec("ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active' CHECK(account_status IN ('pending','active','inactive'))");
  db.exec("UPDATE users SET account_status=CASE WHEN active=1 THEN 'active' ELSE 'inactive' END");
}
if (!columns('users').has('removed_at')) db.exec('ALTER TABLE users ADD COLUMN removed_at TEXT');
if (!columns('users').has('email_verified_at')) {
  db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
  db.exec("UPDATE users SET email_verified_at=created_at WHERE active=1 OR role IN ('owner','admin')");
}
db.exec(`CREATE TABLE IF NOT EXISTS email_verifications (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  last_sent_at TEXT NOT NULL
);`);
const orderColumns = columns('orders');
if (!orderColumns.has('customer_company')) db.exec('ALTER TABLE orders ADD COLUMN customer_company TEXT');
if (!orderColumns.has('quantity')) db.exec('ALTER TABLE orders ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1');
if (!orderColumns.has('due_date')) db.exec('ALTER TABLE orders ADD COLUMN due_date TEXT');
if (!orderColumns.has('updated_by')) {
  db.exec('ALTER TABLE orders ADD COLUMN updated_by TEXT REFERENCES users(id)');
  db.exec('UPDATE orders SET updated_by=created_by WHERE updated_by IS NULL');
}
for (const [name, definition] of Object.entries({
  assigned_to: 'TEXT REFERENCES users(id)', pending_reason: 'TEXT', next_action_date: 'TEXT',
  artwork_status: "TEXT NOT NULL DEFAULT 'not_required'", artwork_note: 'TEXT', artwork_reviewed_by: 'TEXT REFERENCES users(id)', artwork_reviewed_at: 'TEXT',
  delivery_mode: 'TEXT', carrier_name: 'TEXT', driver_name: 'TEXT', driver_phone: 'TEXT', delivery_forecast: 'TEXT', tracking_code: 'TEXT', tracking_url: 'TEXT',
  departed_at: 'TEXT', departed_by: 'TEXT REFERENCES users(id)', delivered_at: 'TEXT', delivered_by: 'TEXT REFERENCES users(id)', received_by: 'TEXT',
})) if (!orderColumns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`);
const eventColumns = columns('order_events');
if (!eventColumns.has('kind')) db.exec("ALTER TABLE order_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'status'");
if (!eventColumns.has('summary')) db.exec('ALTER TABLE order_events ADD COLUMN summary TEXT');
if (!eventColumns.has('details_json')) db.exec('ALTER TABLE order_events ADD COLUMN details_json TEXT');
db.exec("UPDATE order_events SET summary=status WHERE summary IS NULL AND kind='status'");
if (storageDriver === 'supabase' && (!supabaseUrl || !supabaseStorageKey || !/^[a-z0-9][a-z0-9_-]{1,99}$/i.test(supabaseBucket))) {
  throw new Error('Configure SUPABASE_URL, SUPABASE_SECRET_KEY e OPTRACK_STORAGE_BUCKET para anexos privados em produção.');
}
if (storageDriver !== 'local' && storageDriver !== 'supabase') throw new Error('OPTRACK_STORAGE_DRIVER deve ser local ou supabase.');
if (process.env.NODE_ENV === 'production' && storageDriver !== 'supabase') throw new Error('Anexos em produção exigem OPTRACK_STORAGE_DRIVER=supabase.');
const pruneExpiredSessions = () => {
  const now = new Date().toISOString();
  db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
  db.prepare('DELETE FROM email_verifications WHERE expires_at<=?').run(now);
};
pruneExpiredSessions();
const sessionCleanupInterval = setInterval(pruneExpiredSessions, 30 * 60 * 1000);
sessionCleanupInterval.unref();

function json(res, status, data, headers = {}) {
  res.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

function securityHeaders() {
  const production = process.env.NODE_ENV === 'production';
  return {
    'Content-Security-Policy': `default-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none';${production ? ' upgrade-insecure-requests;' : ''}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    ...(production ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

function cookieValue(req, name) {
  const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key, value]) => key && value !== undefined));
  return cookies[name] ? decodeURIComponent(cookies[name]) : null;
}

function setSessionCookie(res, token, maxAge = 60 * 60 * 12) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `optrack_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `optrack_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function makePasswordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

async function checkPassword(password, encoded) {
  const [salt, storedHex] = encoded.split(':');
  if (!salt || !storedHex) return false;
  const actual = Buffer.from(await scryptAsync(password, salt, 64));
  const expected = Buffer.from(storedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function deliverVerificationEmail(email, code) {
  if (!resendApiKey || !emailFrom) {
    if (process.env.NODE_ENV === 'production') throw new Error('Serviço de e-mail não configurado.');
    return false;
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: emailFrom, to: [email], subject: 'Confirme seu e-mail — OP TRACK FLEX PREMIUM',
      text: `Seu código de confirmação do OP TRACK FLEX PREMIUM é ${code}. Ele expira em 15 minutos. Se você não solicitou esse cadastro, ignore esta mensagem.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#182c42"><p>Use este código para confirmar seu e-mail no OP TRACK FLEX PREMIUM:</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>O código expira em 15 minutos. Se você não solicitou este cadastro, ignore esta mensagem.</p></div>`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('O provedor de e-mail não aceitou o envio.');
  return true;
}

async function issueEmailVerification(userId, email) {
  const now = new Date();
  const existing = db.prepare('SELECT last_sent_at FROM email_verifications WHERE user_id=?').get(userId);
  if (existing && now.getTime() - Date.parse(existing.last_sent_at) < 60_000) return { sent: false, cooldown: true };
  const code = String(randomInt(0, 100_000_000)).padStart(8, '0');
  const codeHash = await makePasswordHash(code);
  const sentAt = now.toISOString();
  db.prepare(`INSERT INTO email_verifications(user_id,code_hash,attempts,expires_at,last_sent_at) VALUES(?,?,0,?,?)
    ON CONFLICT(user_id) DO UPDATE SET code_hash=excluded.code_hash,attempts=0,expires_at=excluded.expires_at,last_sent_at=excluded.last_sent_at`)
    .run(userId, codeHash, new Date(now.getTime() + 15 * 60_000).toISOString(), sentAt);
  try {
    const delivered = await deliverVerificationEmail(email, code);
    return { sent: delivered, devVerificationCode: delivered ? undefined : code };
  } catch {
    db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(userId);
    return { sent: false, deliveryFailed: true };
  }
}

function verificationNotice(result) {
  if (result.cooldown) return 'Um código já foi enviado recentemente. Aguarde um minuto ou confira sua caixa de entrada.';
  if (result.deliveryFailed) return 'Não conseguimos enviar o código agora. Tente novamente em instantes.';
  if (result.devVerificationCode) return 'Ambiente local: use o código exibido para confirmar o endereço de e-mail.';
  return 'Enviamos um código de 8 dígitos. Ele expira em 15 minutos.';
}

function matchesConfiguredSecret(value, configured) {
  if (typeof value !== 'string' || !configured) return false;
  const candidate = Buffer.from(value);
  const expected = Buffer.from(configured);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

async function makeTrackingHash(code) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scryptAsync(code, salt, 64);
  return `${salt}:${Buffer.from(derived).toString('hex')}`;
}

async function checkTrackingCode(code, encoded) {
  const [salt, storedHex] = encoded.split(':');
  if (!salt || !storedHex) return false;
  const actual = Buffer.from(await scryptAsync(code, salt, 64));
  const expected = Buffer.from(storedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rateLimit(req, key, maximum, windowMs) {
  const now = Date.now();
  if (now >= nextLimitCleanup) {
    for (const [id, item] of limits) if (now > item.until) limits.delete(id);
    nextLimitCleanup = now + 15_000;
  }
  const ip = req.socket.remoteAddress || 'unknown';
  const id = `${key}:${ip}`;
  const entry = limits.get(id);
  if (!entry || now > entry.until) {
    if (!entry && limits.size >= maxLimitEntries) return false;
    limits.set(id, { count: 1, until: now + windowMs });
    return true;
  }
  entry.count += 1;
  return entry.count <= maximum;
}

async function verifyHuman(token, expectedAction, req) {
  if (!turnstileSiteKey || !turnstileSecretKey) return process.env.NODE_ENV !== 'production';
  if (turnstileTestPair && process.env.NODE_ENV !== 'production') return token === 'XXXX.DUMMY.TOKEN.XXXX';
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: turnstileSecretKey, response: token }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    const expectedHost = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN).hostname : String(req.headers.host || '').split(':')[0].toLowerCase();
    return result.success === true && result.action === expectedAction && result.hostname === expectedHost;
  } catch {
    return false;
  }
}

async function bodyJson(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw Object.assign(new Error('Envie os dados em formato JSON.'), { status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw Object.assign(new Error('Corpo muito grande.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Objeto JSON esperado.');
    return parsed;
  } catch { throw Object.assign(new Error('Envie um objeto JSON válido.'), { status: 400 }); }
}

function clean(value, maxLength = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function userFromRow(row) {
  return row ? { id: row.id, name: row.name, email: row.email, role: row.role } : null;
}

function orderFromRow(row) {
  return {
    id: row.id,
    number: row.number,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    customerCompany: row.customer_company,
    product: row.product,
    quantity: row.quantity,
    destination: row.destination,
    dueDate: row.due_date,
    internalNotes: row.internal_notes,
    status: row.status,
    createdAt: row.created_at,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    updatedAt: row.updated_at,
    updatedByName: row.updated_by_name || row.created_by_name,
    assignedTo: row.assigned_to || null,
    assignedToName: row.assigned_to_name || null,
    pendingReason: row.pending_reason || null,
    nextActionDate: row.next_action_date || null,
    artworkStatus: row.artwork_status || 'not_required',
    artworkNote: row.artwork_note || null,
    artworkReviewedByName: row.artwork_reviewed_by_name || null,
    artworkReviewedAt: row.artwork_reviewed_at || null,
    deliveryMode: row.delivery_mode || null,
    carrierName: row.carrier_name || null,
    driverName: row.driver_name || null,
    driverPhone: row.driver_phone || null,
    deliveryForecast: row.delivery_forecast || row.due_date || null,
    trackingCode: row.tracking_code || null,
    trackingUrl: row.tracking_url || null,
    departedAt: row.departed_at || null,
    departedByName: row.departed_by_name || null,
    deliveredAt: row.delivered_at || null,
    deliveredByName: row.delivered_by_name || null,
    receivedBy: row.received_by || null,
  };
}

function requireUser(req, res) {
  const token = cookieValue(req, 'optrack_session');
  if (!token) {
    json(res, 401, { error: 'Faça login para continuar.' });
    return null;
  }
  const session = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), new Date().toISOString());
  if (!session || !session.active) {
    clearSessionCookie(res);
    json(res, 401, { error: 'Sua sessão expirou. Entre novamente.' });
    return null;
  }
  return userFromRow(session);
}

function orderSelect() {
  return `SELECT o.*, u.name AS created_by_name, COALESCE(uu.name,u.name) AS updated_by_name,
    assignee.name AS assigned_to_name, reviewer.name AS artwork_reviewed_by_name,
    departed.name AS departed_by_name, delivered.name AS delivered_by_name
    FROM orders o JOIN users u ON u.id=o.created_by
    LEFT JOIN users uu ON uu.id=o.updated_by
    LEFT JOIN users assignee ON assignee.id=o.assigned_to
    LEFT JOIN users reviewer ON reviewer.id=o.artwork_reviewed_by
    LEFT JOIN users departed ON departed.id=o.departed_by
    LEFT JOIN users delivered ON delivered.id=o.delivered_by`;
}

function logOrderEvent(orderId, user, status, kind, summary, details = null, note = null, createdAt = new Date().toISOString()) {
  db.prepare(`INSERT INTO order_events(id,order_id,status,note,kind,summary,details_json,actor_id,actor_name,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), orderId, status, note, kind, summary,
    details ? JSON.stringify(details) : null, user.id, user.name, createdAt);
}

function eventFromRow(row) {
  let details = null;
  try { details = row.details_json ? JSON.parse(row.details_json) : null; } catch { details = null; }
  return { id: row.id, kind: row.kind || 'status', status: row.status, summary: row.summary || row.status,
    details, note: row.note, actorName: row.actor_name, createdAt: row.created_at };
}

function attachmentFromRow(row) {
  return { id: row.id, label: row.label, category: row.category, originalName: row.original_name,
    mimeType: row.mime_type, sizeBytes: row.size_bytes, customerVisible: Boolean(row.customer_visible),
    uploadedByName: row.uploaded_by_name, uploadedAt: row.uploaded_at };
}

function storageObjectPath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

function supabaseStorageHeaders(extra = {}) {
  const headers = { apikey: supabaseStorageKey, ...extra };
  // New sb_secret keys are API keys, not JWTs; legacy service_role keys still need a bearer header.
  if (!supabaseStorageKey.startsWith('sb_secret_')) headers.Authorization = `Bearer ${supabaseStorageKey}`;
  return headers;
}

async function savePrivateFile(key, contentType, bytes) {
  if (storageDriver === 'local') {
    const path = resolve(privateFilesDir, key);
    if (!path.startsWith(`${privateFilesDir}${sep}`)) throw new Error('Caminho de armazenamento inválido.');
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return;
  }
  const endpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}/${storageObjectPath(key)}`;
  const response = await fetch(endpoint, { method: 'POST', headers: supabaseStorageHeaders({ 'Content-Type': contentType, 'x-upsert': 'false' }), body: bytes });
  if (!response.ok) throw new Error('O armazenamento privado recusou o arquivo.');
}

async function readPrivateFile(key) {
  if (storageDriver === 'local') {
    const path = resolve(privateFilesDir, key);
    if (!path.startsWith(`${privateFilesDir}${sep}`)) throw new Error('Caminho de armazenamento inválido.');
    return readFile(path);
  }
  const endpoint = `${supabaseUrl}/storage/v1/object/authenticated/${encodeURIComponent(supabaseBucket)}/${storageObjectPath(key)}`;
  const response = await fetch(endpoint, { headers: supabaseStorageHeaders() });
  if (!response.ok) throw new Error('Arquivo privado indisponível.');
  return Buffer.from(await response.arrayBuffer());
}

async function deletePrivateFile(key) {
  if (storageDriver === 'local') {
    const path = resolve(privateFilesDir, key);
    if (path.startsWith(`${privateFilesDir}${sep}`)) await unlink(path).catch(() => undefined);
    return;
  }
  const endpoint = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(supabaseBucket)}/${storageObjectPath(key)}`;
  await fetch(endpoint, { method: 'DELETE', headers: supabaseStorageHeaders() }).catch(() => undefined);
}

async function readRequestBytes(req, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) throw Object.assign(new Error('O arquivo excede o limite de 6 MB.'), { status: 413 });
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('O arquivo excede o limite de 6 MB.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) throw Object.assign(new Error('Selecione um arquivo válido.'), { status: 400 });
  return Buffer.concat(chunks);
}

function sniffFile(bytes) {
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') return { mime: 'application/pdf', ext: 'pdf' };
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return { mime: 'image/png', ext: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  return null;
}

function safeFileName(value) {
  return clean(value, 180).replace(/[\\/\r\n\0]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '_').trim() || 'arquivo';
}

async function sendAttachment(res, file, inline = false) {
  const bytes = await readPrivateFile(file.storage_key);
  const filename = safeFileName(file.original_name).replace(/[";]/g, '_');
  res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': file.mime_type,
    'Content-Length': bytes.length,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  });
  res.end(bytes);
}

function requireOwner(user, res) {
  if (user.role !== 'owner') {
    json(res, 403, { error: 'Esta ação requer a Conta Proprietária.' });
    return false;
  }
  return true;
}

function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function nextOrderNumber() {
  const year = new Date().getFullYear();
  const prefix = clean(process.env.OPTRACK_OP_PREFIX || 'OP', 12).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'OP';
  const widthValue = Number(process.env.OPTRACK_SEQUENCE_WIDTH || 6);
  const width = Number.isFinite(widthValue) ? Math.min(12, Math.max(4, Math.floor(widthValue))) : 6;
  const sequence = db.prepare('SELECT next_value FROM sequences WHERE year=?').get(year);
  const value = sequence?.next_value ?? 1;
  db.prepare(`INSERT INTO sequences(year,next_value) VALUES(?,?)
    ON CONFLICT(year) DO UPDATE SET next_value=excluded.next_value`).run(year, value + 1);
  return `${prefix}-${year}-${String(value).padStart(width, '0')}`;
}

async function createOrder(input, user) {
  const customerName = clean(input.customerName, 120);
  const product = clean(input.product, 180);
  if (!customerName || !product) throw Object.assign(new Error('Informe o cliente e o produto/projeto.'), { status: 400 });
  const quantity = Number(input.quantity ?? 1);
  const dueDate = clean(input.dueDate, 10) || null;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) throw Object.assign(new Error('A quantidade deve ser um número inteiro entre 1 e 1.000.000.'), { status: 400 });
  if (dueDate && !validDateOnly(dueDate)) throw Object.assign(new Error('Informe uma data de entrega válida.'), { status: 400 });
  const customerEmail = clean(input.customerEmail, 180).toLowerCase() || null;
  if (customerEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerEmail)) throw Object.assign(new Error('Informe um e-mail válido.'), { status: 400 });
  const customerPhone = clean(input.customerPhone, 40);
  if (customerPhone && (!/^[\d+().\s-]+$/.test(customerPhone) || customerPhone.replace(/\D/g, '').length < 8 || customerPhone.replace(/\D/g, '').length > 15)) throw Object.assign(new Error('Informe um telefone válido.'), { status: 400 });
  const assignedTo = clean(input.assignedTo, 36) || null;
  if (assignedTo && !db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(assignedTo)) throw Object.assign(new Error('Selecione uma pessoa ativa da equipe.'), { status: 400 });
  const now = new Date().toISOString();
  const id = randomUUID();
  const trackingCode = randomBytes(7).toString('hex').toUpperCase();
  const trackingHash = await makeTrackingHash(trackingCode);
  const number = transaction(() => {
    const generated = nextOrderNumber();
    db.prepare(`INSERT INTO orders(id,number,customer_name,customer_email,customer_phone,customer_company,product,quantity,destination,due_date,internal_notes,status,tracking_hash,created_at,created_by,updated_at,updated_by,assigned_to)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, generated, customerName, customerEmail, customerPhone || null,
      clean(input.customerCompany, 150) || null, product, quantity, clean(input.destination, 180) || null, dueDate, clean(input.internalNotes, 1000) || null,
      STATUSES[0], trackingHash, now, user.id, now, user.id, assignedTo);
    logOrderEvent(id, user, STATUSES[0], 'status', STATUSES[0], { previousStatus: null }, null, now);
    if (assignedTo) logOrderEvent(id, user, STATUSES[0], 'assignment', `Responsável definido: ${db.prepare('SELECT name FROM users WHERE id=?').get(assignedTo).name}`, { assignedTo }, null, now);
    return generated;
  });
  return { order: orderFromRow(db.prepare(`${orderSelect()} WHERE o.id=?`).get(id)), trackingCode };
}

function validDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateFromPeriod(period) {
  if (period === 'all') return null;
  const days = period === '30d' ? 30 : 7;
  const date = new Date();
  date.setDate(date.getDate() - (days - 1));
  return date.toISOString().slice(0, 10);
}

async function routeApi(req, res, url) {
  const path = url.pathname;
  const method = req.method || 'GET';

  if (path === '/api/health' && method === 'GET') return json(res, 200, { ok: true });
  if (path === '/api/public-config' && method === 'GET') return json(res, 200, { turnstile: { enabled: Boolean(turnstileSiteKey && turnstileSecretKey), required: process.env.NODE_ENV === 'production', siteKey: turnstileSiteKey || null } });
  if (path === '/api/session' && method === 'GET') {
    const users = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
    const token = cookieValue(req, 'optrack_session');
    let user = null;
    if (token) {
      const session = db.prepare(`SELECT u.id,u.name,u.email,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), new Date().toISOString());
      if (session?.active) user = userFromRow(session);
    }
    return json(res, 200, { setupRequired: users === 0, user });
  }

  if (path === '/api/setup' && method === 'POST') {
    if (!rateLimit(req, 'setup', 5, 60_000)) return json(res, 429, { error: 'Muitas tentativas. Aguarde um minuto.' });
    const input = await bodyJson(req);
    if (!await verifyHuman(input.turnstileToken, 'account', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    if (process.env.NODE_ENV === 'production' && !matchesConfiguredSecret(input.bootstrapToken, process.env.OPTRACK_SETUP_TOKEN)) return json(res, 403, { error: 'Chave de ativação inválida.' });
    const name = clean(input.name, 120);
    const email = clean(input.email, 180).toLowerCase();
    const password = typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) return json(res, 400, { error: 'Informe nome, e-mail válido e senha entre 12 e 256 caracteres.' });
    const passwordHash = await makePasswordHash(password);
    const id = randomUUID();
    const now = new Date().toISOString();
    const created = transaction(() => {
      if (db.prepare('SELECT COUNT(*) AS count FROM users').get().count !== 0) return false;
      db.prepare("INSERT INTO users(id,name,email,password_hash,role,active,account_status,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, name, email, passwordHash, 'owner', 0, 'pending', now);
      return true;
    });
    if (!created) return json(res, 409, { error: 'A configuração inicial já foi concluída. Faça login.' });
    const verification = await issueEmailVerification(id, email);
    return json(res, 202, { verificationRequired: true, email, message: verificationNotice(verification), devVerificationCode: verification.devVerificationCode });
  }

  if (path === '/api/register' && method === 'POST') {
    if (!rateLimit(req, 'register', 5, 60_000)) return json(res, 429, { error: 'Muitas tentativas de cadastro. Aguarde um minuto.' });
    const input = await bodyJson(req);
    if (clean(input.website, 200)) return json(res, 202, { pending: true, message: 'Se os dados forem válidos, seu pedido de acesso será analisado pela equipe.' });
    if (!await verifyHuman(input.turnstileToken, 'account', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    if (!db.prepare("SELECT id FROM users WHERE role='owner' AND active=1 LIMIT 1").get()) return json(res, 409, { error: 'A Conta Proprietária precisa concluir a configuração inicial antes de aceitar cadastros.' });
    const name = clean(input.name, 120);
    const email = clean(input.email, 180).toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 256) return json(res, 400, { error: 'Informe nome, e-mail válido e senha entre 12 e 256 caracteres.' });
    const existing = db.prepare('SELECT id,email_verified_at,account_status FROM users WHERE email=?').get(email);
    if (existing) {
      if (!existing.email_verified_at && existing.account_status === 'pending') {
        const verification = await issueEmailVerification(existing.id, email);
        return json(res, 202, { verificationRequired: true, email, message: verificationNotice(verification), devVerificationCode: verification.devVerificationCode });
      }
      return json(res, 202, { verificationRequired: false, message: 'Se o endereço puder iniciar um cadastro, enviaremos as instruções necessárias.' });
    }
    let userId = randomUUID();
    try {
      db.prepare('INSERT INTO users(id,name,email,password_hash,role,active,account_status,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(userId, name, email, await makePasswordHash(password), 'viewer', 0, 'pending', new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 202, { verificationRequired: false, message: 'Se o endereço puder iniciar um cadastro, enviaremos as instruções necessárias.' });
      throw error;
    }
    const verification = await issueEmailVerification(userId, email);
    return json(res, 202, { verificationRequired: true, email, message: verificationNotice(verification), devVerificationCode: verification.devVerificationCode });
  }

  if (path === '/api/register/verify' && method === 'POST') {
    if (!rateLimit(req, 'email-verify', 10, 60_000)) return json(res, 429, { error: 'Muitas tentativas de confirmação. Aguarde um minuto.' });
    const input = await bodyJson(req);
    if (!await verifyHuman(input.turnstileToken, 'account', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    const email = clean(input.email, 180).toLowerCase();
    const code = clean(input.code, 8);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{8}$/.test(code)) return json(res, 400, { error: 'Informe o e-mail e o código de 8 dígitos.' });
    const account = db.prepare('SELECT id,name,email,role,active,account_status,email_verified_at FROM users WHERE email=?').get(email);
    const verification = account && db.prepare('SELECT code_hash,attempts,expires_at FROM email_verifications WHERE user_id=?').get(account.id);
    if (!account || account.email_verified_at || !verification) return json(res, 400, { error: 'Código inválido ou expirado. Solicite outro código.' });
    if (Date.parse(verification.expires_at) <= Date.now()) {
      db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(account.id);
      return json(res, 400, { error: 'Código expirado. Solicite outro código.' });
    }
    if (verification.attempts >= 5) {
      db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(account.id);
      return json(res, 429, { error: 'Limite de tentativas atingido. Solicite outro código.' });
    }
    if (!await checkPassword(code, verification.code_hash)) {
      db.prepare('UPDATE email_verifications SET attempts=attempts+1 WHERE user_id=?').run(account.id);
      return json(res, 400, { error: 'Código inválido. Confira a mensagem recebida e tente novamente.' });
    }
    const shouldLogin = account.role === 'owner' || Boolean(account.active);
    const sessionToken = shouldLogin ? randomBytes(32).toString('base64url') : null;
    const now = new Date().toISOString();
    transaction(() => {
      if (account.role === 'owner' && !account.active) db.prepare("UPDATE users SET email_verified_at=?,active=1,account_status='active' WHERE id=?").run(now, account.id);
      else db.prepare('UPDATE users SET email_verified_at=? WHERE id=?').run(now, account.id);
      db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(account.id);
      if (sessionToken) db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), account.id, digest(sessionToken), new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), now);
    });
    if (sessionToken) {
      setSessionCookie(res, sessionToken);
      return json(res, 200, { verified: true, user: { id: account.id, name: account.name, email: account.email, role: account.role } });
    }
    return json(res, 200, { verified: true, message: 'E-mail confirmado. A Conta Proprietária precisa aprovar seu acesso antes do primeiro login.' });
  }

  if (path === '/api/register/resend' && method === 'POST') {
    if (!rateLimit(req, 'email-resend', 4, 60_000)) return json(res, 429, { error: 'Muitos reenvios. Aguarde um minuto.' });
    const input = await bodyJson(req);
    if (!await verifyHuman(input.turnstileToken, 'account', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    const email = clean(input.email, 180).toLowerCase();
    const account = db.prepare('SELECT id,email_verified_at,account_status FROM users WHERE email=?').get(email);
    const verification = account && !account.email_verified_at && account.account_status === 'pending' ? await issueEmailVerification(account.id, email) : null;
    return json(res, 202, { verificationRequired: true, message: verification ? verificationNotice(verification) : 'Se existir uma confirmação pendente, enviaremos um novo código.', devVerificationCode: verification?.devVerificationCode });
  }

  if (path === '/api/login' && method === 'POST') {
    if (!rateLimit(req, 'login', 8, 60_000)) return json(res, 429, { error: 'Muitas tentativas de acesso. Aguarde um minuto.' });
    const input = await bodyJson(req);
    if (!await verifyHuman(input.turnstileToken, 'account', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    const email = clean(input.email, 180).toLowerCase();
    const password = typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
    const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!row || !(await checkPassword(password, row.password_hash))) return json(res, 401, { error: 'E-mail ou senha incorretos.' });
    if (!row.email_verified_at) {
      const verification = await issueEmailVerification(row.id, row.email);
      return json(res, 403, { error: verificationNotice(verification), verificationRequired: true, email: row.email, devVerificationCode: verification.devVerificationCode });
    }
    if (row.account_status === 'pending') return json(res, 403, { error: 'Este acesso ainda aguarda aprovação da Conta Proprietária.' });
    if (!row.active) return json(res, 403, { error: 'Este acesso está desativado. Fale com um administrador.' });
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), row.id, digest(token), new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), now);
    setSessionCookie(res, token);
    return json(res, 200, { user: userFromRow(row) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const token = cookieValue(req, 'optrack_session');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
    clearSessionCookie(res);
    return json(res, 200, { ok: true });
  }

  if (path === '/api/track' && method === 'POST') {
    if (!rateLimit(req, 'track', 12, 60_000)) return json(res, 429, { error: 'Muitas consultas. Aguarde um minuto e tente novamente.' });
    const input = await bodyJson(req);
    if (!await verifyHuman(input.turnstileToken, 'tracking', req)) return json(res, 400, { error: 'Conclua a verificação antirrobô e tente novamente.' });
    const number = clean(input.orderNumber, 40).toUpperCase();
    const code = clean(input.trackingCode, 80).toUpperCase();
    if (!number || !code) return json(res, 400, { error: 'Informe o número da OP e o código de rastreamento.' });
    const order = db.prepare('SELECT id,number,customer_name,status,created_at,due_date,delivery_forecast,tracking_code,tracking_url,tracking_hash FROM orders WHERE number=?').get(number);
    if (!order || !(await checkTrackingCode(code, order.tracking_hash))) return json(res, 404, { error: 'Não encontramos uma OP com esses dados. Confira o número e o código.' });
    const events = db.prepare("SELECT status,created_at FROM order_events WHERE order_id=? AND kind='status' ORDER BY created_at ASC").all(order.id);
    const proofAvailable = Boolean(db.prepare("SELECT id FROM order_attachments WHERE order_id=? AND category='delivery_proof' AND customer_visible=1 LIMIT 1").get(order.id));
    return json(res, 200, { order: { number: order.number, customerName: order.customer_name, status: order.status, createdAt: order.created_at,
      deliveryForecast: order.delivery_forecast || order.due_date, trackingCode: order.tracking_code, trackingUrl: order.tracking_url, proofAvailable },
      events: events.map((event) => ({ status: event.status, createdAt: event.created_at })) });
  }

  if (path === '/api/track/proof' && method === 'POST') {
    if (!rateLimit(req, 'track-proof', 8, 60_000)) return json(res, 429, { error: 'Muitas consultas. Aguarde um minuto e tente novamente.' });
    const input = await bodyJson(req);
    const number = clean(input.orderNumber, 40).toUpperCase();
    const code = clean(input.trackingCode, 80).toUpperCase();
    if (!number || !code) return json(res, 400, { error: 'Informe o número da OP e o código de rastreamento.' });
    const order = db.prepare('SELECT id,tracking_hash FROM orders WHERE number=?').get(number);
    if (!order || !(await checkTrackingCode(code, order.tracking_hash))) return json(res, 404, { error: 'Não encontramos uma OP com esses dados.' });
    const file = db.prepare("SELECT * FROM order_attachments WHERE order_id=? AND category='delivery_proof' AND customer_visible=1 ORDER BY uploaded_at DESC LIMIT 1").get(order.id);
    if (!file) return json(res, 404, { error: 'Não há comprovante autorizado para compartilhamento.' });
    return sendAttachment(res, file, true);
  }

  const user = requireUser(req, res);
  if (!user) return;
  if (path === '/api/account/password' && method === 'POST') {
    if (!rateLimit(req, 'password-change', 5, 15 * 60_000)) return json(res, 429, { error: 'Muitas tentativas de alteração. Aguarde alguns minutos.' });
    const input = await bodyJson(req);
    const currentPassword = typeof input.currentPassword === 'string' && input.currentPassword.length <= 256 ? input.currentPassword : '';
    const newPassword = typeof input.newPassword === 'string' ? input.newPassword : '';
    const confirmPassword = typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
    if (newPassword.length < 12 || newPassword.length > 256 || newPassword !== confirmPassword) return json(res, 400, { error: 'A nova senha deve ter de 12 a 256 caracteres e coincidir com a confirmação.' });
    const account = db.prepare('SELECT password_hash FROM users WHERE id=? AND active=1').get(user.id);
    if (!account || !(await checkPassword(currentPassword, account.password_hash))) return json(res, 403, { error: 'A senha atual não confere.' });
    if (newPassword === currentPassword) return json(res, 400, { error: 'Escolha uma senha diferente da atual.' });
    const salt = randomBytes(16).toString('hex');
    const passwordHash = `${salt}:${Buffer.from(await scryptAsync(newPassword, salt, 64)).toString('hex')}`;
    const token = randomBytes(32).toString('base64url');
    const now = new Date().toISOString();
    transaction(() => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, user.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), user.id, digest(token), new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(), now);
    });
    setSessionCookie(res, token);
    return json(res, 200, { ok: true });
  }
  if (!['GET', 'HEAD'].includes(method)) {
    if (!rateLimit(req, 'authenticated-write', 60, 60_000)) return json(res, 429, { error: 'Muitas alterações em pouco tempo. Aguarde um minuto.' });
    if (user.role === 'viewer') return json(res, 403, { error: 'Seu perfil permite somente consultar as ordens.' });
  }

  if (path === '/api/dashboard' && method === 'GET') {
    const from = dateFromPeriod(url.searchParams.get('period') || '7d');
    const counts = db.prepare(`SELECT status,COUNT(*) AS count FROM orders GROUP BY status`).all();
    const statusCounts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    counts.forEach((row) => { statusCounts[row.status] = row.count; });
    const total = Object.values(statusCounts).reduce((sum, value) => sum + value, 0);
    const activity = db.prepare(`SELECT e.status,e.created_at,e.actor_name,o.number,o.customer_name
      FROM order_events e JOIN orders o ON o.id=e.order_id ORDER BY e.created_at DESC LIMIT 6`).all();
    const chartRows = from ? db.prepare(`SELECT substr(created_at,1,10) AS day,COUNT(*) AS count FROM order_events WHERE created_at>=? GROUP BY substr(created_at,1,10) ORDER BY day`).all(`${from}T00:00:00.000Z`) : db.prepare(`SELECT substr(created_at,1,10) AS day,COUNT(*) AS count FROM order_events GROUP BY substr(created_at,1,10) ORDER BY day`).all();
    const series = [];
    const days = url.searchParams.get('period') === '30d' ? 30 : url.searchParams.get('period') === 'all' ? 0 : 7;
    if (days) {
      const chartMap = new Map(chartRows.map((row) => [row.day, row.count]));
      for (let index = days - 1; index >= 0; index -= 1) {
        const day = new Date();
        day.setDate(day.getDate() - index);
        const key = day.toISOString().slice(0, 10);
        series.push({ day: key, count: chartMap.get(key) || 0 });
      }
    } else chartRows.forEach((row) => series.push({ day: row.day, count: row.count }));
    const orders = db.prepare(`${orderSelect()} ORDER BY o.created_at DESC LIMIT 5`).all().map(orderFromRow);
    const today = new Date().toISOString().slice(0, 10);
    const dueThrough = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const openStatuses = STATUSES.slice(0, -1);
    const overdueCount = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE due_date<? AND status IN (?,?,?)`).get(today, ...openStatuses).count;
    const dueSoonCount = db.prepare(`SELECT COUNT(*) AS count FROM orders WHERE due_date>=? AND due_date<=? AND status IN (?,?,?)`).get(today, dueThrough, ...openStatuses).count;
    const dueOrders = db.prepare(`${orderSelect()} WHERE o.due_date IS NOT NULL AND o.due_date<=? AND o.status IN (?,?,?) ORDER BY o.due_date ASC LIMIT 8`).all(dueThrough, ...openStatuses).map(orderFromRow);
    return json(res, 200, { total, statusCounts, overdueCount, dueSoonCount, dueOrders, activity: activity.map((row) => ({ status: row.status, createdAt: row.created_at, actorName: row.actor_name, orderNumber: row.number, customerName: row.customer_name })), series, orders });
  }

  if (path === '/api/orders' && method === 'GET') {
    const search = clean(url.searchParams.get('search'), 120);
    const status = url.searchParams.get('status');
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const where = [];
    const params = [];
    if (search) { where.push('(o.number LIKE ? OR o.customer_name LIKE ? OR o.customer_company LIKE ? OR o.product LIKE ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
    if (STATUSES.includes(status)) { where.push('o.status=?'); params.push(status); }
    if (validDateOnly(from || '')) { where.push('o.created_at>=?'); params.push(`${from}T00:00:00.000Z`); }
    if (validDateOnly(to || '')) { where.push('o.created_at<?'); params.push(`${to}T23:59:59.999Z`); }
    const sql = `${orderSelect()} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY o.created_at DESC LIMIT 250`;
    return json(res, 200, { orders: db.prepare(sql).all(...params).map(orderFromRow) });
  }

  if (path === '/api/orders' && method === 'POST') {
    const input = await bodyJson(req);
    const created = await createOrder(input, user);
    return json(res, 201, created);
  }

  const orderMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)$/i);
  if (orderMatch && method === 'GET') {
    const order = db.prepare(`${orderSelect()} WHERE o.id=?`).get(orderMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    const events = db.prepare('SELECT id,status,note,kind,summary,details_json,actor_name,created_at FROM order_events WHERE order_id=? ORDER BY created_at ASC,id ASC').all(orderMatch[1]);
    const attachments = db.prepare('SELECT * FROM order_attachments WHERE order_id=? ORDER BY uploaded_at DESC').all(orderMatch[1]).map(attachmentFromRow);
    return json(res, 200, { order: orderFromRow(order), events: events.map(eventFromRow), attachments });
  }

  if (orderMatch && method === 'PATCH') {
    const input = await bodyJson(req);
    const order = db.prepare('SELECT id FROM orders WHERE id=?').get(orderMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    const customerName = clean(input.customerName, 120);
    const product = clean(input.product, 180);
    const email = clean(input.customerEmail, 180).toLowerCase() || null;
    const phone = clean(input.customerPhone, 40);
    const quantity = Number(input.quantity ?? 1);
    const dueDate = clean(input.dueDate, 10) || null;
    if (!customerName || !product) return json(res, 400, { error: 'Cliente e produto/projeto são obrigatórios.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Informe um e-mail válido.' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000) return json(res, 400, { error: 'A quantidade deve ser um número inteiro entre 1 e 1.000.000.' });
    if (dueDate && !validDateOnly(dueDate)) return json(res, 400, { error: 'Informe uma data de entrega válida.' });
    if (phone && (!/^[\d+().\s-]+$/.test(phone) || phone.replace(/\D/g, '').length < 8 || phone.replace(/\D/g, '').length > 15)) return json(res, 400, { error: 'Informe um telefone válido.' });
    const now = new Date().toISOString();
    db.prepare(`UPDATE orders SET customer_name=?,customer_email=?,customer_phone=?,customer_company=?,product=?,quantity=?,destination=?,due_date=?,internal_notes=?,updated_at=?,updated_by=? WHERE id=?`).run(customerName, email,
      phone || null, clean(input.customerCompany, 150) || null, product, quantity, clean(input.destination, 180) || null, dueDate,
      clean(input.internalNotes, 1000) || null, now, user.id, orderMatch[1]);
    logOrderEvent(orderMatch[1], user, db.prepare('SELECT status FROM orders WHERE id=?').get(orderMatch[1]).status, 'order_update', 'Dados gerais da OP atualizados');
    return json(res, 200, { order: orderFromRow(db.prepare(`${orderSelect()} WHERE o.id=?`).get(orderMatch[1])) });
  }

  const statusMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/status$/i);
  if (statusMatch && method === 'POST') {
    const input = await bodyJson(req);
    const current = db.prepare('SELECT id,status FROM orders WHERE id=?').get(statusMatch[1]);
    if (!current) return json(res, 404, { error: 'OP não encontrada.' });
    const currentIndex = STATUSES.indexOf(current.status);
    if (input.status !== STATUSES[currentIndex + 1]) return json(res, 400, { error: 'A OP deve avançar para a próxima etapa na ordem definida.' });
    const receivedBy = clean(input.receivedBy, 120);
    if (input.status === STATUSES[3] && !receivedBy) return json(res, 400, { error: 'Informe o nome de quem recebeu a OP.' });
    const now = new Date().toISOString();
    transaction(() => {
      if (input.status === STATUSES[2]) db.prepare('UPDATE orders SET status=?,updated_at=?,updated_by=?,departed_at=?,departed_by=? WHERE id=?').run(input.status, now, user.id, now, user.id, current.id);
      else if (input.status === STATUSES[3]) db.prepare('UPDATE orders SET status=?,updated_at=?,updated_by=?,delivered_at=?,delivered_by=?,received_by=? WHERE id=?').run(input.status, now, user.id, now, user.id, receivedBy, current.id);
      else db.prepare('UPDATE orders SET status=?,updated_at=?,updated_by=? WHERE id=?').run(input.status, now, user.id, current.id);
      logOrderEvent(current.id, user, input.status, 'status', input.status,
        input.status === STATUSES[3] ? { previousStatus: current.status, receivedBy } : { previousStatus: current.status }, clean(input.note, 500) || null, now);
    });
    return json(res, 200, { ok: true });
  }

  const codeMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/tracking-code$/i);
  if (codeMatch && method === 'POST') {
    const current = db.prepare('SELECT id,status FROM orders WHERE id=?').get(codeMatch[1]);
    if (!current) return json(res, 404, { error: 'OP não encontrada.' });
    const code = randomBytes(7).toString('hex').toUpperCase();
    const hash = await makeTrackingHash(code);
    const now = new Date().toISOString();
    db.prepare('UPDATE orders SET tracking_hash=?,updated_at=?,updated_by=? WHERE id=?').run(hash, now, user.id, current.id);
    logOrderEvent(current.id, user, current.status, 'tracking_code', 'Código individual de acesso do cliente regenerado', null, null, now);
    return json(res, 200, { trackingCode: code });
  }

  if (path === '/api/assignees' && method === 'GET') {
    const users = db.prepare("SELECT id,name,role FROM users WHERE active=1 ORDER BY name COLLATE NOCASE").all();
    return json(res, 200, { users });
  }

  const operationsMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/operations$/i);
  if (operationsMatch && method === 'POST') {
    const input = await bodyJson(req);
    const order = db.prepare('SELECT id,status,assigned_to,pending_reason,next_action_date,artwork_status,artwork_note,artwork_reviewed_by,artwork_reviewed_at FROM orders WHERE id=?').get(operationsMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    const assignedTo = clean(input.assignedTo, 36) || null;
    if (assignedTo && !db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(assignedTo)) return json(res, 400, { error: 'Selecione uma pessoa ativa da equipe.' });
    const pendingReason = clean(input.pendingReason, 500) || null;
    const nextActionDate = clean(input.nextActionDate, 10) || null;
    if (pendingReason && (!nextActionDate || !validDateOnly(nextActionDate))) return json(res, 400, { error: 'Informe uma data válida para retomar a pendência.' });
    if (!pendingReason && nextActionDate) return json(res, 400, { error: 'Informe o motivo da pendência ou remova a data para retomar.' });
    const artworkStatus = input.artworkStatus;
    if (!['not_required','pending','approved','changes_requested'].includes(artworkStatus)) return json(res, 400, { error: 'Selecione um estado válido para a arte.' });
    const artworkNote = clean(input.artworkNote, 500) || null;
    const now = new Date().toISOString();
    const artworkChanged = artworkStatus !== order.artwork_status || artworkNote !== (order.artwork_note || null);
    const newArtworkDecision = artworkStatus !== order.artwork_status && ['approved', 'changes_requested'].includes(artworkStatus);
    const reviewedBy = newArtworkDecision ? user.id : ['approved', 'changes_requested'].includes(artworkStatus) ? order.artwork_reviewed_by : null;
    const reviewedAt = newArtworkDecision ? now : ['approved', 'changes_requested'].includes(artworkStatus) ? order.artwork_reviewed_at : null;
    transaction(() => {
      db.prepare(`UPDATE orders SET assigned_to=?,pending_reason=?,next_action_date=?,artwork_status=?,artwork_note=?,
        artwork_reviewed_by=?,artwork_reviewed_at=?,updated_at=?,updated_by=? WHERE id=?`).run(assignedTo, pendingReason, nextActionDate,
        artworkStatus, artworkNote, reviewedBy, reviewedAt, now, user.id, order.id);
      if (assignedTo !== order.assigned_to) {
        const assignee = assignedTo ? db.prepare('SELECT name FROM users WHERE id=?').get(assignedTo)?.name : null;
        logOrderEvent(order.id, user, order.status, 'assignment', assignee ? `Responsável definido: ${assignee}` : 'Responsável removido', { assignedTo, assignee });
      }
      if (pendingReason !== order.pending_reason || nextActionDate !== order.next_action_date) {
        logOrderEvent(order.id, user, order.status, 'pending_update', pendingReason ? 'Pendência e próxima ação atualizadas' : 'Pendência encerrada', { pendingReason, nextActionDate });
      }
      if (artworkChanged) logOrderEvent(order.id, user, order.status, 'artwork_update', `Aprovação da arte: ${artworkStatus === 'approved' ? 'aprovada' : artworkStatus === 'changes_requested' ? 'ajustes solicitados' : artworkStatus === 'pending' ? 'aguardando' : 'não necessária'}`, { artworkStatus, artworkNote, reviewedBy, reviewedAt });
    });
    return json(res, 200, { ok: true });
  }

  const logisticsMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/logistics$/i);
  if (logisticsMatch && method === 'PATCH') {
    const input = await bodyJson(req);
    const order = db.prepare('SELECT id,status,delivery_mode,carrier_name,driver_name,driver_phone,delivery_forecast,tracking_code,tracking_url FROM orders WHERE id=?').get(logisticsMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    const deliveryMode = clean(input.deliveryMode, 30) || null;
    if (deliveryMode && !['own_fleet','carrier','customer_pickup'].includes(deliveryMode)) return json(res, 400, { error: 'Selecione uma modalidade de entrega válida.' });
    const carrierName = clean(input.carrierName, 140) || null;
    if (deliveryMode === 'carrier' && !carrierName) return json(res, 400, { error: 'Informe a transportadora.' });
    const driverName = clean(input.driverName, 120) || null;
    const driverPhone = clean(input.driverPhone, 40) || null;
    if (driverPhone && (!/^[\d+().\s-]+$/.test(driverPhone) || driverPhone.replace(/\D/g, '').length < 8 || driverPhone.replace(/\D/g, '').length > 15)) return json(res, 400, { error: 'Informe um telefone de motorista válido.' });
    const deliveryForecast = clean(input.deliveryForecast, 10) || null;
    if (deliveryForecast && !validDateOnly(deliveryForecast)) return json(res, 400, { error: 'Informe uma previsão de entrega válida.' });
    const trackingCode = clean(input.trackingCode, 100) || null;
    const trackingUrl = clean(input.trackingUrl, 500) || null;
    if (trackingUrl) {
      try { const parsed = new URL(trackingUrl); if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error(); }
      catch { return json(res, 400, { error: 'O link de rastreamento deve ser HTTPS e válido.' }); }
    }
    const changedFields = [
      ['delivery_mode', 'modalidade', deliveryMode], ['carrier_name', 'transportadora', deliveryMode === 'carrier' ? carrierName : null],
      ['driver_name', 'motorista', deliveryMode === 'customer_pickup' ? null : driverName],
      ['driver_phone', 'telefone do motorista', deliveryMode === 'customer_pickup' ? null : driverPhone],
      ['delivery_forecast', 'previsão de entrega', deliveryForecast], ['tracking_code', 'código de rastreio', trackingCode],
      ['tracking_url', 'link de rastreio', trackingUrl],
    ].filter(([key, , value]) => (order[key] || null) !== (value || null));
    if (!changedFields.length) return json(res, 200, { ok: true });
    const now = new Date().toISOString();
    db.prepare(`UPDATE orders SET delivery_mode=?,carrier_name=?,driver_name=?,driver_phone=?,delivery_forecast=?,tracking_code=?,tracking_url=?,updated_at=?,updated_by=? WHERE id=?`)
      .run(deliveryMode, deliveryMode === 'carrier' ? carrierName : null, deliveryMode === 'customer_pickup' ? null : driverName,
        deliveryMode === 'customer_pickup' ? null : driverPhone, deliveryForecast, trackingCode, trackingUrl, now, user.id, order.id);
    const changedLabels = changedFields.map(([, label]) => label);
    logOrderEvent(order.id, user, order.status, 'logistics_update', `Logística atualizada: ${changedLabels.join(', ')}`, { changedFields: changedLabels }, null, now);
    return json(res, 200, { ok: true });
  }

  const attemptMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/delivery-attempt$/i);
  if (attemptMatch && method === 'POST') {
    const input = await bodyJson(req);
    const order = db.prepare('SELECT id,status FROM orders WHERE id=?').get(attemptMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    if (order.status !== STATUSES[2]) return json(res, 409, { error: 'Registre a ocorrência quando a OP estiver em Saiu para entrega.' });
    const reason = clean(input.reason, 500);
    const nextAttemptDate = clean(input.nextAttemptDate, 10);
    if (!reason || !validDateOnly(nextAttemptDate)) return json(res, 400, { error: 'Informe o motivo e a data válida da próxima tentativa.' });
    const now = new Date().toISOString();
    db.prepare('UPDATE orders SET delivery_forecast=?,updated_at=?,updated_by=? WHERE id=?').run(nextAttemptDate, now, user.id, order.id);
    logOrderEvent(order.id, user, order.status, 'delivery_attempt', 'Tentativa de entrega sem sucesso', { reason, nextAttemptDate }, null, now);
    return json(res, 201, { ok: true });
  }

  const fileListMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/files$/i);
  if (fileListMatch && method === 'GET') {
    const exists = db.prepare('SELECT id FROM orders WHERE id=?').get(fileListMatch[1]);
    if (!exists) return json(res, 404, { error: 'OP não encontrada.' });
    const files = db.prepare('SELECT * FROM order_attachments WHERE order_id=? ORDER BY uploaded_at DESC').all(fileListMatch[1]).map(attachmentFromRow);
    return json(res, 200, { files });
  }
  if (fileListMatch && method === 'POST') {
    if (!rateLimit(req, 'file-upload', 12, 60_000)) return json(res, 429, { error: 'Muitos arquivos em pouco tempo. Aguarde um minuto.' });
    const order = db.prepare('SELECT id,status FROM orders WHERE id=?').get(fileListMatch[1]);
    if (!order) return json(res, 404, { error: 'OP não encontrada.' });
    const category = clean(req.headers['x-op-file-category'], 30);
    let label = '';
    let originalName = '';
    try {
      label = clean(decodeURIComponent(String(req.headers['x-op-file-label'] || '')), 80);
      originalName = safeFileName(decodeURIComponent(String(req.headers['x-op-file-name'] || '')));
    }
    catch { return json(res, 400, { error: 'O nome do arquivo é inválido.' }); }
    if (!['artwork','approval','delivery_proof','other'].includes(category) || label.length < 2) return json(res, 400, { error: 'Informe uma categoria e um nome claro para o arquivo.' });
    const customerVisible = String(req.headers['x-op-customer-visible'] || '') === 'true';
    if (customerVisible && category !== 'delivery_proof') return json(res, 400, { error: 'Somente comprovantes de entrega podem ser compartilhados com o cliente.' });
    const bytes = await readRequestBytes(req, 6 * 1024 * 1024);
    const detected = sniffFile(bytes);
    if (!detected) return json(res, 415, { error: 'Formato não permitido. Envie PDF, PNG, JPG ou WEBP.' });
    const incomingType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    if (incomingType && incomingType !== 'application/octet-stream' && incomingType !== detected.mime) return json(res, 415, { error: 'O tipo informado não corresponde ao arquivo enviado.' });
    const id = randomUUID();
    const storageKey = `${id}.${detected.ext}`;
    const now = new Date().toISOString();
    await savePrivateFile(storageKey, detected.mime, bytes);
    try {
      transaction(() => {
        db.prepare(`INSERT INTO order_attachments(id,order_id,label,category,original_name,storage_key,mime_type,size_bytes,customer_visible,uploaded_by,uploaded_by_name,uploaded_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, order.id, label, category, originalName, storageKey, detected.mime, bytes.length, customerVisible ? 1 : 0, user.id, user.name, now);
        db.prepare('UPDATE orders SET updated_at=?,updated_by=? WHERE id=?').run(now, user.id, order.id);
        logOrderEvent(order.id, user, order.status, 'file_uploaded', `Arquivo adicionado: ${label}`, { fileId: id, label, category, originalName, customerVisible }, null, now);
      });
    } catch (error) {
      await deletePrivateFile(storageKey);
      throw error;
    }
    const file = db.prepare('SELECT * FROM order_attachments WHERE id=?').get(id);
    return json(res, 201, { file: attachmentFromRow(file) });
  }

  const fileMatch = path.match(/^\/api\/orders\/([0-9a-f-]+)\/files\/([0-9a-f-]+)$/i);
  if (fileMatch && method === 'GET') {
    const file = db.prepare('SELECT * FROM order_attachments WHERE id=? AND order_id=?').get(fileMatch[2], fileMatch[1]);
    if (!file) return json(res, 404, { error: 'Arquivo não encontrado.' });
    return sendAttachment(res, file);
  }

  if (path === '/api/users' && method === 'GET') {
    if (!requireOwner(user, res)) return;
    const users = db.prepare('SELECT id,name,email,role,active,account_status,removed_at,email_verified_at,created_at FROM users ORDER BY CASE account_status WHEN \'pending\' THEN 0 ELSE 1 END, removed_at, created_at ASC').all();
    return json(res, 200, { users: users.map((row) => ({ id: row.id, name: row.name, email: row.email, role: row.role, active: Boolean(row.active), accountStatus: row.account_status, removedAt: row.removed_at, emailVerifiedAt: row.email_verified_at, createdAt: row.created_at })) });
  }

  if (path === '/api/users' && method === 'POST') {
    if (!requireOwner(user, res)) return;
    const input = await bodyJson(req);
    const name = clean(input.name, 120);
    const email = clean(input.email, 180).toLowerCase();
    const password = typeof input.password === 'string' ? input.password : '';
    const role = ['admin', 'operator', 'viewer'].includes(input.role) ? input.role : null;
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12 || password.length > 256) return json(res, 400, { error: 'Preencha nome, e-mail válido e senha entre 12 e 256 caracteres.' });
    if (!role) return json(res, 400, { error: 'Selecione um perfil de acesso válido.' });
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return json(res, 409, { error: 'Já existe uma conta com este e-mail.' });
    const id = randomUUID();
    try {
      db.prepare("INSERT INTO users(id,name,email,password_hash,role,active,account_status,created_at) VALUES(?,?,?,?,?,?,?,?)").run(id, name, email, await makePasswordHash(password), role, 0, 'pending', new Date().toISOString());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Já existe uma conta com este e-mail.' });
      throw error;
    }
    const verification = await issueEmailVerification(id, email);
    return json(res, 202, { user: { id, name, email, role, active: false }, verificationRequired: true, message: verificationNotice(verification), devVerificationCode: verification.devVerificationCode });
  }

  const userMatch = path.match(/^\/api\/users\/([0-9a-f-]+)$/i);
  if (userMatch && method === 'DELETE') {
    if (!requireOwner(user, res)) return;
    const target = db.prepare('SELECT id,role FROM users WHERE id=?').get(userMatch[1]);
    if (!target) return json(res, 404, { error: 'Conta não encontrada.' });
    if (target.role === 'owner' || target.id === user.id) return json(res, 403, { error: 'A Conta Proprietária não pode ser removida.' });
    const id = target.id;
    const orderReferences = db.prepare('SELECT COUNT(*) AS count FROM orders WHERE created_by=? OR updated_by=? OR assigned_to=? OR artwork_reviewed_by=? OR departed_by=? OR delivered_by=?').get(id, id, id, id, id, id).count;
    const eventReferences = db.prepare('SELECT COUNT(*) AS count FROM order_events WHERE actor_id=?').get(id).count;
    const fileReferences = db.prepare('SELECT COUNT(*) AS count FROM order_attachments WHERE uploaded_by=?').get(id).count;
    const hasHistory = orderReferences + eventReferences + fileReferences > 0;
    transaction(() => {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      if (hasHistory) db.prepare("UPDATE users SET active=0,account_status='inactive',removed_at=? WHERE id=?").run(new Date().toISOString(), id);
      else db.prepare('DELETE FROM users WHERE id=?').run(id);
    });
    return json(res, 200, { removed: hasHistory ? 'archived' : 'deleted' });
  }
  if (userMatch && method === 'PATCH') {
    if (!requireOwner(user, res)) return;
    const target = db.prepare('SELECT id,name,email,role,active,account_status,removed_at,email_verified_at FROM users WHERE id=?').get(userMatch[1]);
    if (!target) return json(res, 404, { error: 'Usuário não encontrado.' });
    if (target.role === 'owner') return json(res, 403, { error: 'A Conta Proprietária não pode ser alterada por este painel.' });
    const input = await bodyJson(req);
    const role = ['admin','operator','viewer'].includes(input.role) ? input.role : null;
    const active = input.active === true ? 1 : input.active === false ? 0 : null;
    if (!role || active === null) return json(res, 400, { error: 'Informe um perfil e um estado de acesso válidos.' });
    if (active && !target.email_verified_at) return json(res, 409, { error: 'Este e-mail precisa ser confirmado antes de liberar o acesso.' });
    if (target.removed_at && (active !== 1 || role !== target.role)) return json(res, 409, { error: 'Restaure a conta antes de alterar o perfil ou o acesso.' });
    if (target.id === user.id && (role !== target.role || active !== target.active)) return json(res, 400, { error: 'Para alterar o próprio perfil, peça a outro administrador.' });
    const accountStatus = active ? 'active' : target.account_status === 'pending' ? 'pending' : 'inactive';
    db.prepare('UPDATE users SET role=?,active=?,account_status=?,removed_at=CASE WHEN ?=1 THEN NULL ELSE removed_at END WHERE id=?').run(role, active, accountStatus, active, target.id);
    if (!active) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    return json(res, 200, { user: { id: target.id, name: target.name, email: target.email, role, active: Boolean(active), accountStatus } });
  }

  return json(res, 404, { error: 'Rota não encontrada.' });
}

async function serveStatic(req, res, url) {
  if (!['GET', 'HEAD'].includes(req.method || '')) return json(res, 405, { error: 'Método não permitido.' }, { Allow: 'GET, HEAD' });
  const dist = resolve(root, 'dist');
  let requested;
  try { requested = decodeURIComponent(url.pathname).replace(/^[/\\]+/, ''); }
  catch { return json(res, 400, { error: 'Caminho inválido.' }); }
  const candidate = resolve(dist, requested || 'index.html');
  if (candidate !== dist && !candidate.startsWith(`${dist}${sep}`)) return json(res, 400, { error: 'Caminho inválido.' });
  const file = existsSync(candidate) && extname(candidate) ? candidate : join(dist, 'index.html');
  if (!existsSync(file)) return json(res, 404, { error: 'Interface não compilada. Execute pnpm build.' });
  res.writeHead(200, { ...securityHeaders(), 'Content-Type': mimeTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

if (process.env.NODE_ENV === 'production') {
  if (!process.env.APP_ORIGIN) throw new Error('Configure APP_ORIGIN com a origem pública exata antes de iniciar em produção.');
  try {
    const origin = new URL(process.env.APP_ORIGIN);
    if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== process.env.APP_ORIGIN || origin.protocol !== 'https:') throw new Error();
  } catch { throw new Error('APP_ORIGIN deve ser uma origem HTTPS válida, sem caminho ou barra final.'); }
  if (!process.env.OPTRACK_SETUP_TOKEN || Buffer.byteLength(process.env.OPTRACK_SETUP_TOKEN) < 32) throw new Error('Configure OPTRACK_SETUP_TOKEN com pelo menos 32 bytes aleatórios antes de iniciar em produção.');
  if (!process.env.TURNSTILE_SITE_KEY || !process.env.TURNSTILE_SECRET_KEY) throw new Error('Configure TURNSTILE_SITE_KEY e TURNSTILE_SECRET_KEY antes de iniciar em produção.');
  if (turnstileTestPair) throw new Error('Chaves de teste do Turnstile não podem ser usadas em produção.');
  if (!resendApiKey || !emailFrom) throw new Error('Configure RESEND_API_KEY e OPTRACK_EMAIL_FROM para confirmação de e-mail em produção.');
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method || '')) {
        if (process.env.NODE_ENV === 'production' && !req.headers.origin) return json(res, 403, { error: 'Origem não permitida.' });
        if (req.headers.origin && process.env.APP_ORIGIN && req.headers.origin !== process.env.APP_ORIGIN) return json(res, 403, { error: 'Origem não permitida.' });
      }
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (status === 500) console.error(error);
    if (!res.headersSent) json(res, status, { error: status === 500 ? 'Ocorreu um erro ao processar sua solicitação.' : error.message });
    else res.end();
  }
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;

const port = Number(process.env.PORT || 4179);
const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
server.listen(port, host, () => console.log(`OP TRACK FLEX PREMIUM API disponível em http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => { clearInterval(sessionCleanupInterval); db.close(); process.exit(0); });
});
