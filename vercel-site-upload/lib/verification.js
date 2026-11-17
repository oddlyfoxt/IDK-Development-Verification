import crypto from 'node:crypto';

const REQUIRED_ENVIRONMENT = [
  'ROBLOX_CLIENT_ID',
  'ROBLOX_CLIENT_SECRET',
  'ROBLOX_REDIRECT_URI',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'DISCORD_REDIRECT_URI',
  'DISCORD_TOKEN',
  'OAUTH_STATE_SECRET',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
];

export function requireEnvironment() {
  for (const key of REQUIRED_ENVIRONMENT) {
    if (!process.env[key]) throw new Error(`Missing ${key}`);
  }
  let supabaseUrl;
  try {
    supabaseUrl = new URL(process.env.SUPABASE_URL);
  } catch {
    throw new Error('SUPABASE_URL must be an absolute HTTPS URL');
  }
  if (supabaseUrl.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');

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
  if (typeof user.preferred_username !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(user.preferred_username)) {
    throw new Error('Roblox did not return a valid username');
  }
  return user;
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

export async function assignVerifiedRole(config, discordUserId, robloxUserId, robloxUsername) {
  if (!config || !/^\d{17,20}$/.test(config.guildId)
    || !/^\d{17,20}$/.test(config.verifiedRoleId)
    || !/^\d{17,20}$/.test(config.panelChannelId)
    || !/^\d{17,20}$/.test(config.logChannelId)) {
    throw new Error('Cannot assign a role without a valid server verification configuration');
  }
  if (!/^\d+$/.test(discordUserId) || !/^\d+$/.test(String(robloxUserId))) {
    throw new Error('Cannot assign a role without valid Discord and Roblox account IDs');
  }
  if (typeof robloxUsername !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(robloxUsername)) {
    throw new Error('Cannot log verification without a valid Roblox username');
  }
  const memberPath = `https://discord.com/api/v10/guilds/${encodeURIComponent(config.guildId)}/members/${encodeURIComponent(discordUserId)}/roles`;
  const roleUrl = `${memberPath}/${encodeURIComponent(config.verifiedRoleId)}`;
  const roleResponse = await discordRequest(roleUrl, 'PUT');
  if (!roleResponse.ok) throw new Error(`Discord could not assign the verified role (HTTP ${roleResponse.status})`);

  const unverifiedRoleId = config.unverifiedRoleId;
  if (unverifiedRoleId && unverifiedRoleId !== config.verifiedRoleId) {
    try {
      const response = await discordRequest(`${memberPath}/${encodeURIComponent(unverifiedRoleId)}`, 'DELETE');
      if (!response.ok) {
        console.error(`[verification] Verified role was assigned, but unverified role removal failed with HTTP ${response.status}.`);
      }
    } catch (error) {
      console.error('[verification] Verified role was assigned, but unverified role removal failed:', error);
    }
  }

  try {
    const response = await discordRequest(
      `https://discord.com/api/v10/channels/${encodeURIComponent(config.logChannelId)}/messages`,
      'POST',
      {
        flags: 1 << 15,
        components: [{
          type: 17,
          components: [{
            type: 10,
            content: [
              '## Member Verified',
              `**Discord User:** <@${discordUserId}>`,
              `**Roblox Username:** @${robloxUsername}`,
              `**Roblox User ID:** \`${robloxUserId}\``,
              '**Method:** Roblox',
              `**Verified At:** <t:${Math.floor(Date.now() / 1000)}:F>`,
            ].join('\n'),
          }],
        }],
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

export const escape = input => String(input).replace(/[&<>"']/g, char => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char]);

export const page = (title, body) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="theme-color" content="#111315">
  <link rel="icon" type="image/png" href="/favicon.png">
  <title>${escape(title)} · IDK Development</title>
  <style>
    :root{color-scheme:dark;font:16px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#111315;color:#f4f4f4}
    *{box-sizing:border-box}
    body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(ellipse at 76% 18%,#283236 0,transparent 42%),linear-gradient(135deg,#141718,#101112 62%,#171a1b)}
    .shell{width:min(100%,480px)}
    .brand{display:flex;align-items:center;gap:12px;margin:0 0 20px 4px;color:#e8e8e8;font-size:14px;font-weight:650;letter-spacing:.01em}
    .brand img{width:38px;height:38px;object-fit:contain;padding:7px;border:1px solid #ffffff22;border-radius:12px;background:#1b1d1f}
    main{padding:clamp(26px,6vw,40px);border:1px solid #ffffff20;border-radius:16px;background:linear-gradient(145deg,#1c1e20f5,#17191bf5);box-shadow:0 28px 80px #0007}
    .eyebrow{margin-bottom:22px;color:#a5a7a9;font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase}
    h1{margin:0;color:#f5f5f5;font-size:clamp(25px,5vw,31px);line-height:1.2;letter-spacing:-.035em}
    p{margin:14px 0 0;color:#a7aaad;font-size:14px;line-height:1.7}
    a{color:#e6e6e6}
    @media(max-width:480px){body{padding:18px}.brand{margin-left:2px}}
  </style>
</head>
<body>
  <div class="shell">
    <div class="brand"><img src="/favicon.png" alt=""><span>IDK Development</span></div>
    <main><div class="eyebrow">Account verification</div>${body}</main>
  </div>
</body>
</html>`;

export function sendPage(res, status, title, body) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'");
  res.status(status).setHeader('content-type', 'text/html; charset=utf-8').send(page(title, body));
}
