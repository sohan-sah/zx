const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Hash a room code with a server-only pepper so the plaintext code
// is never stored in the database. Deterministic, so the same code
// always hashes the same way and can be looked up by hash.
function hashRoomCode(code) {
  const pepper = process.env.ROOM_CODE_PEPPER || 'change-me-in-vercel-env';
  return crypto.createHash('sha256').update(`${pepper}:${code}`).digest('hex');
}

// A 6-digit numeric code, Free-Fire-room-code style.
function generateRoomCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

// Service-role client — full DB access, bypasses RLS.
// SUPABASE_SERVICE_ROLE_KEY must only ever be set as a server-side
// Vercel environment variable, never exposed to the frontend bundle.
function adminClient() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { autoRefreshToken: false, persistSession: false } }
  );
}

// Reads the "Authorization: Bearer <access_token>" header the
// frontend sends (the user's own Supabase session token) and
// resolves it to a verified user id. Returns null if missing/invalid.
async function getUserFromRequest(req, admin) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

function send(res, status, body) {
  res.status(status).json(body);
}

module.exports = { adminClient, getUserFromRequest, send, hashRoomCode, generateRoomCode };
