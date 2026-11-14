import crypto from 'node:crypto';

const REQUIRED_ENVIRONMENT = [
  'ROBLOX_CLIENT_ID',
  'ROBLOX_CLIENT_SECRET',
  'ROBLOX_REDIRECT_URI',
  'ROBLOX_GROUP_ID',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_GUILD_ID',
  'DISCORD_TOKEN',
  'VERIFY_MEMBER_ROLE_ID',
  'OAUTH_STATE_SECRET',
];

export function requireEnvironment() {
  for (const key of REQUIRED_ENVIRONMENT) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  if (!/^\d+$/.test(process.env.ROBLOX_GROUP_ID)) {
    throw new Error('ROBLOX_GROUP_ID must contain only digits');
  }
  for (const key of ['DISCORD_GUILD_ID', 'VERIFY_MEMBER_ROLE_ID']) {
    if (!/^\d+$/.test(process.env[key])) throw new Error(`${key} must contain only digits`);
  }
  if (process.env.VERIFY_UNVERIFIED_ROLE_ID && !/^\d+$/.test(process.env.VERIFY_UNVERIFIED_ROLE_ID)) {
    throw new Error('VERIFY_UNVERIFIED_ROLE_ID must contain only digits');
  }
  if (process.env.VERIFY_LOG_CHANNEL_ID && !/^\d+$/.test(process.env.VERIFY_LOG_CHANNEL_ID)) {
    throw new Error('VERIFY_LOG_CHANNEL_ID must contain only digits');
  }

  validateRedirectUri(process.env.ROBLOX_REDIRECT_URI, '/api/roblox/callback', 'ROBLOX_REDIRECT_URI');
  validateRedirectUri(process.env.DISCORD_REDIRECT_URI, '/api/roblox/discord-callback', 'DISCORD_REDIRECT_URI');
  stateKey();
}

function validateRedirectUri(value, pathname, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL`);
  }
  if (url.protocol !== 'https:' || url.pathname !== pathname || url.search || url.hash) {
    throw new Error(`${name} must be HTTPS and end with ${pathname}`);
  }
}

export const random = bytes => crypto.randomBytes(bytes).toString('base64url');
export const challenge = verifier => crypto.createHash('sha256').update(verifier).digest('base64url');

function stateKey() {
  const encoded = process.env.OAUTH_STATE_SECRET || '';
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('OAUTH_STATE_SECRET must be a base64-encoded 32-byte value');
  }
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('OAUTH_STATE_SECRET must be a base64-encoded 32-byte value');
  }
  return key;
}

export function sealState(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', stateKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}

export function openState(value) {
  try {
    if (typeof value !== 'string' || value.length > 4096) return null;
    const raw = Buffer.from(value, 'base64url');
    if (raw.length < 29) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', stateKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const state = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    return state && Number.isInteger(state.exp) && state.exp > Date.now() ? state : null;
  } catch {
    return null;
  }
}

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
  return response.json();
}

export async function exchangeDiscordCode(code) {
  const tokens = await fetchJson('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
    }),
  });
  if (!tokens.access_token) throw new Error('Discord OAuth did not return an access token');

  const user = await fetchJson('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!user.id || !/^\d+$/.test(user.id)) throw new Error('Discord did not return a valid user ID');
  return user.id;
}

export async function exchangeRobloxCode(code, verifier) {
  const tokens = await fetchJson('https://apis.roblox.com/oauth/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: process.env.ROBLOX_CLIENT_ID,
      client_secret: process.env.ROBLOX_CLIENT_SECRET,
      redirect_uri: process.env.ROBLOX_REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!tokens.access_token) throw new Error('Roblox OAuth did not return an access token');

  const user = await fetchJson('https://apis.roblox.com/oauth/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!user.sub || !/^\d+$/.test(user.sub)) throw new Error('Roblox did not return a valid account ID');
  return user;
}

export async function isGroupMember(robloxUserId) {
  const result = await fetchJson(
    `https://groups.roblox.com/v2/users/${encodeURIComponent(robloxUserId)}/groups/roles`
  );
  if (!Array.isArray(result.data)) throw new Error('Roblox group response was not in the expected format');
  return result.data.some(entry => String(entry.group?.id) === process.env.ROBLOX_GROUP_ID);
}

async function discordRequest(url, method, body) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });
  return response;
}

export async function assignVerifiedRole(discordUserId, robloxUserId) {
  if (!/^\d+$/.test(discordUserId) || !/^\d+$/.test(String(robloxUserId))) {
    throw new Error('Cannot assign a role without valid Discord and Roblox account IDs');
  }
  const memberPath = `https://discord.com/api/v10/guilds/${encodeURIComponent(process.env.DISCORD_GUILD_ID)}/members/${encodeURIComponent(discordUserId)}/roles`;
  const roleUrl = `${memberPath}/${encodeURIComponent(process.env.VERIFY_MEMBER_ROLE_ID)}`;
  const roleResponse = await discordRequest(roleUrl, 'PUT');
  if (!roleResponse.ok) throw new Error(`Discord could not assign the verified role (HTTP ${roleResponse.status})`);

  const unverifiedRoleId = process.env.VERIFY_UNVERIFIED_ROLE_ID;
  if (unverifiedRoleId && unverifiedRoleId !== process.env.VERIFY_MEMBER_ROLE_ID) {
    try {
      const response = await discordRequest(`${memberPath}/${encodeURIComponent(unverifiedRoleId)}`, 'DELETE');
      if (!response.ok) {
        console.error(`[verification] Verified role was assigned, but unverified role removal failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      console.error('[verification] Verified role was assigned, but unverified role removal failed:', error);
    }
  }

  const logChannelId = process.env.VERIFY_LOG_CHANNEL_ID;
  if (logChannelId) {
    try {
      const response = await discordRequest(
        `https://discord.com/api/v10/channels/${encodeURIComponent(logChannelId)}/messages`,
        'POST',
        {
          content: `Member Verified\nDiscord User: <@${discordUserId}>\nRoblox User ID: ${robloxUserId}\nMethod: Roblox group\nVerified At: <t:${Math.floor(Date.now() / 1000)}:F>`,
          allowed_mentions: { parse: [] },
        }
      );
      if (!response.ok) {
        console.error(`[verification] Member was verified, but log delivery failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      console.error('[verification] Member was verified, but log delivery failed:', error);
    }
  }
}

export const escape = input => String(input).replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);

export const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#10131c"><title>${escape(title)} · Roblox Verification</title><style>:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#10131c;color:#f4f5f8}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 50% -15%,#252b43 0,transparent 56%),#10131c}main{width:min(100%,520px);padding:clamp(28px,7vw,48px);border:1px solid #ffffff13;border-radius:24px;background:linear-gradient(145deg,#1d2230f5,#171b27f5);box-shadow:0 28px 90px #0006}.brand{margin-bottom:34px;color:#a99aff;font-size:12px;font-weight:750;letter-spacing:.16em}h1{margin:0;font-size:clamp(25px,5vw,32px);line-height:1.2;letter-spacing:-.04em}p{margin:14px 0 0;color:#b4bac8;font-size:15px;line-height:1.75}a{color:#c0b5ff}</style></head><body><main><div class="brand">ACCOUNT VERIFICATION</div>${body}</main></body></html>`;

export function sendPage(res, status, title, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.status(status).setHeader('content-type', 'text/html; charset=utf-8').send(page(title, body));
}
