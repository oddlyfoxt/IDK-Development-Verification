import { getGuildConfig, getVerificationStats, saveGuildConfig } from './guild-config.js';
import { openState, random, sealState, sendPage } from './verification.js';

const STATE_COOKIE = 'idk_admin_oauth_state';
const SESSION_COOKIE = 'idk_admin_session';
const STATE_TTL_MS = 10 * 60_000;
const SESSION_TTL_MS = 60 * 60_000;
const ADMIN_PERMISSION = 8n;
const ADMIN_GUILD_CACHE_TTL_MS = 15_000;
const adminGuildCache = new Map();
const adminGuildRequests = new Map();

function queryValue(req, key) {
  const value = req.query?.[key];
  return typeof value === 'string' ? value : '';
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator >= 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function cookie(name, value, path, maxAge) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function redirect(res, location, cookies = []) {
  res.statusCode = 302;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', location);
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end();
}

function sendJson(res, status, body) {
  res.setHeader('cache-control', 'no-store');
  return res.status(status).json(body);
}

function adminRedirectUri() {
  const value = process.env.DISCORD_ADMIN_REDIRECT_URI;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('DISCORD_ADMIN_REDIRECT_URI must be an absolute HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.pathname !== '/api/admin/callback' || url.search || url.hash) {
    throw new Error('DISCORD_ADMIN_REDIRECT_URI must end with /api/admin/callback');
  }
  return url;
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  if (origin && origin !== adminRedirectUri().origin) throw new Error('Cross-origin dashboard requests are not allowed');
}

async function discordJson(url, authorization) {
  const response = await fetch(url, {
    headers: { authorization },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error(`Discord request failed with HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function exchangeAdminCode(code) {
  const response = await fetch('https://discord.com/api/v10/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: adminRedirectUri().toString(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord OAuth token exchange failed with HTTP ${response.status}`);
  const tokens = await response.json();
  if (!tokens.access_token) throw new Error('Discord OAuth did not return an access token');
  return tokens.access_token;
}

function requireSession(req) {
  const session = openState(cookieValue(req, SESSION_COOKIE));
  if (
    !session
    || session.stage !== 'admin-session'
    || typeof session.userId !== 'string'
    || typeof session.accessToken !== 'string'
  ) {
    throw new Error('Sign in with Discord to use the server dashboard.');
  }
  return session;
}

async function adminGuilds(session) {
  const now = Date.now();
  for (const [userId, cached] of adminGuildCache) {
    if (cached.expiresAt <= now) adminGuildCache.delete(userId);
  }
  const cached = adminGuildCache.get(session.userId);
  if (cached) return cached.guilds;

  const pending = adminGuildRequests.get(session.userId);
  if (pending) return pending;

  const request = (async () => {
    const guilds = await discordJson(
      'https://discord.com/api/v10/users/@me/guilds',
      `Bearer ${session.accessToken}`,
    );
    if (!Array.isArray(guilds)) throw new Error('Discord returned an invalid server list');
    const manageableGuilds = guilds.filter(guild => {
      try {
        return guild.owner === true || (BigInt(guild.permissions || '0') & ADMIN_PERMISSION) === ADMIN_PERMISSION;
      } catch {
        return false;
      }
    });
    adminGuildCache.set(session.userId, {
      guilds: manageableGuilds,
      expiresAt: Date.now() + ADMIN_GUILD_CACHE_TTL_MS,
    });
    return manageableGuilds;
  })().finally(() => adminGuildRequests.delete(session.userId));
  adminGuildRequests.set(session.userId, request);
  return request;
}

async function authorizedGuild(req, guildId) {
  if (!/^\d{17,20}$/.test(guildId)) throw new Error('Choose a valid Discord server.');
  const session = requireSession(req);
  const guilds = await adminGuilds(session);
  const guild = guilds.find(item => item.id === guildId);
  if (!guild) throw new Error('You must have Administrator permission in this server.');
  return { session, guild };
}

async function botGuildOptions(guildId) {
  if (!process.env.DISCORD_TOKEN) throw new Error('The dashboard bot token is not configured.');
  const authorization = `Bot ${process.env.DISCORD_TOKEN}`;
  const [rolesResponse, channelsResponse] = await Promise.all([
    fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    }),
    fetch(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    }),
  ]);
  if (!rolesResponse.ok) {
    if (rolesResponse.status === 404) {
      throw new Error('The dashboard bot cannot find this server. Make sure the bot configured with DISCORD_TOKEN is a member of this server.');
    }
    throw new Error(`The bot could not list server roles (HTTP ${rolesResponse.status}).`);
  }
  if (!channelsResponse.ok) {
    if (channelsResponse.status === 404) {
      throw new Error('The dashboard bot cannot find this server. Make sure the bot configured with DISCORD_TOKEN is a member of this server.');
    }
    throw new Error(`The bot could not list server channels (HTTP ${channelsResponse.status}); check its server permissions.`);
  }
  const [roles, channels] = await Promise.all([rolesResponse.json(), channelsResponse.json()]);
  if (!Array.isArray(roles) || !Array.isArray(channels)) throw new Error('Discord returned invalid role or channel data.');
  return {
    roles: roles.map(role => ({
      id: role.id,
      name: role.name,
      position: role.position,
      managed: role.managed === true,
    })),
    channels: channels
      .filter(channel => channel.type === 0)
      .map(channel => ({ id: channel.id, name: channel.name })),
  };
}

function methodNotAllowed(res, methods) {
  res.setHeader('allow', methods);
  return sendJson(res, 405, { error: 'Method not allowed.' });
}

export async function adminLoginHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const redirectUri = adminRedirectUri();
    const state = sealState({
      stage: 'admin-oauth',
      nonce: random(32),
      exp: Date.now() + STATE_TTL_MS,
    });
    const authorization = new URL('https://discord.com/oauth2/authorize');
    authorization.search = new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: redirectUri.toString(),
      response_type: 'code',
      scope: 'identify guilds',
      state,
    });
    return redirect(res, authorization.toString(), [
      cookie(STATE_COOKIE, state, '/api/admin/callback', 600),
    ]);
  } catch (error) {
    console.error('[admin] Could not start Discord sign-in:', error);
    return sendJson(res, 503, { error: 'The dashboard sign-in is not configured.' });
  }
}

export async function adminCallbackHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const clearState = cookie(STATE_COOKIE, '', '/api/admin/callback', 0);
  try {
    const stateValue = queryValue(req, 'state');
    const storedState = cookieValue(req, STATE_COOKIE);
    const state = openState(stateValue);
    if (!state || state.stage !== 'admin-oauth' || !storedState || stateValue !== storedState) {
      res.setHeader('set-cookie', clearState);
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to the dashboard and sign in again.</p>');
    }
    if (queryValue(req, 'error') || !queryValue(req, 'code')) {
      res.setHeader('set-cookie', clearState);
      return sendPage(res, 400, 'Sign-in cancelled', '<h1>Sign-in cancelled</h1><p>No server settings were changed.</p>');
    }

    const accessToken = await exchangeAdminCode(queryValue(req, 'code'));
    const user = await discordJson('https://discord.com/api/v10/users/@me', `Bearer ${accessToken}`);
    if (!user.id || !/^\d{17,20}$/.test(user.id)) throw new Error('Discord did not return a valid user ID');
    const session = sealState({
      stage: 'admin-session',
      userId: user.id,
      username: user.global_name || user.username || 'Discord user',
      accessToken,
      exp: Date.now() + SESSION_TTL_MS,
    });
    redirect(res, new URL('/dashboard.html', adminRedirectUri()).toString(), [
      clearState,
      cookie(SESSION_COOKIE, session, '/api/admin', 3600),
    ]);
  } catch (error) {
    console.error('[admin] Discord sign-in failed:', error);
    res.setHeader('set-cookie', clearState);
    return sendPage(res, 502, 'Sign-in unavailable', '<h1>Sign-in unavailable</h1><p>We could not sign you in. Please try again later.</p>');
  }
}

export async function adminLogoutHandler(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  try {
    assertSameOrigin(req);
    return redirect(res, new URL('/dashboard.html', adminRedirectUri()).toString(), [
      cookie(SESSION_COOKIE, '', '/api/admin', 0),
    ]);
  } catch (error) {
    return sendJson(res, 403, { error: error.message });
  }
}

export async function adminSessionHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const session = requireSession(req);
    return sendJson(res, 200, { user: { id: session.userId, username: session.username } });
  } catch {
    return sendJson(res, 401, { error: 'Sign in with Discord to continue.' });
  }
}

export async function adminGuildsHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const session = requireSession(req);
    const guilds = await adminGuilds(session);
    const results = await Promise.all(guilds.map(async guild => ({
      id: guild.id,
      name: guild.name,
      icon: guild.icon,
      config: await getGuildConfig(guild.id),
    })));
    return sendJson(res, 200, { guilds: results });
  } catch (error) {
    console.error('[admin] Could not load administrator servers:', error);
    if (error.status === 429) {
      return sendJson(res, 503, { error: 'Discord is temporarily rate-limiting dashboard requests. Wait a few seconds and try again.' });
    }
    return sendJson(res, 401, { error: 'Could not load your servers. Sign in again or check the site configuration.' });
  }
}

export async function adminOptionsHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const guildId = queryValue(req, 'guild_id');
    await authorizedGuild(req, guildId);
    return sendJson(res, 200, await botGuildOptions(guildId));
  } catch (error) {
    return sendJson(res, error.status === 429 ? 503 : 403, {
      error: error.status === 429
        ? 'Discord is temporarily rate-limiting dashboard requests. Wait a few seconds and try again.'
        : error.message,
    });
  }
}

export async function adminConfigHandler(req, res) {
  if (!['GET', 'PUT'].includes(req.method)) return methodNotAllowed(res, 'GET, PUT');
  try {
    if (req.method === 'PUT') assertSameOrigin(req);
    const guildId = req.method === 'GET'
      ? queryValue(req, 'guild_id')
      : String(req.body?.guildId || '');
    await authorizedGuild(req, guildId);
    if (req.method === 'GET') {
      return sendJson(res, 200, { config: await getGuildConfig(guildId) });
    }

    const input = req.body || {};
    const options = await botGuildOptions(guildId);
    const roleIds = new Set(options.roles.map(role => role.id));
    const channelIds = new Set(options.channels.map(channel => channel.id));
    const config = {
      guildId,
      verifiedRoleId: String(input.verifiedRoleId || ''),
      unverifiedRoleId: input.unverifiedRoleId ? String(input.unverifiedRoleId) : null,
      panelChannelId: String(input.panelChannelId || ''),
      logChannelId: String(input.logChannelId || ''),
      panelTitle: String(input.panelTitle || '').trim(),
      panelDescription: String(input.panelDescription || '').trim(),
    };
    if (!roleIds.has(config.verifiedRoleId)
      || (config.unverifiedRoleId && !roleIds.has(config.unverifiedRoleId))
      || !channelIds.has(config.panelChannelId)
      || !channelIds.has(config.logChannelId)) {
      return sendJson(res, 400, { error: 'Choose roles and text channels from this server.' });
    }
    await saveGuildConfig(config);
    return sendJson(res, 200, { config });
  } catch (error) {
    console.error('[admin] Could not read or save server settings:', error);
    return sendJson(res, error.status === 429 ? 503 : 400, {
      error: error.status === 429
        ? 'Discord is temporarily rate-limiting dashboard requests. Wait a few seconds and try again.'
        : error.message,
    });
  }
}

export async function adminStatsHandler(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const guildId = queryValue(req, 'guild_id');
    await authorizedGuild(req, guildId);
    const rows = await getVerificationStats(guildId, 90);
    return sendJson(res, 200, { stats: rows });
  } catch (error) {
    return sendJson(res, error.status === 429 ? 503 : 403, {
      error: error.status === 429
        ? 'Discord is temporarily rate-limiting dashboard requests. Wait a few seconds and try again.'
        : error.message,
    });
  }
}

export async function adminProfileHandler(req, res) {
  if (req.method !== 'PUT') return methodNotAllowed(res, 'PUT');
  try {
    assertSameOrigin(req);
    const input = req.body || {};
    const guildId = String(input.guildId || '');
    await authorizedGuild(req, guildId);
    const nick = typeof input.displayName === 'string' ? input.displayName.trim() : '';
    if (!nick || nick.length > 32) {
      return sendJson(res, 400, { error: 'Display name must be between 1 and 32 characters.' });
    }
    const response = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/@me`, {
      method: 'PATCH',
      headers: {
        authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ nick }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return sendJson(res, 502, { error: `Discord could not update the bot nickname (HTTP ${response.status}).` });
    }
    return sendJson(res, 200, { saved: true });
  } catch (error) {
    return sendJson(res, 403, { error: error.message });
  }
}
