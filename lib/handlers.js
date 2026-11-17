import crypto from 'node:crypto';
import {
  assignVerifiedRole,
  challenge,
  exchangeDiscordCode,
  exchangeRobloxCode,
  openState,
  random,
  requireEnvironment,
  sealState,
  sendPage,
} from './verification.js';
import {
  getGuildConfig,
  recordVerificationStat,
  saveVerificationLink,
} from './guild-config.js';

const DISCORD_COOKIE = 'verification_discord_state';
const ROBLOX_COOKIE = 'verification_roblox_state';
const DISCORD_CALLBACK_PATH = '/api/roblox/discord-callback';
const ROBLOX_CALLBACK_PATH = '/api/roblox/callback';
const STATE_TTL_MS = 10 * 60_000;

function queryValue(req, key) {
  const value = req.query?.[key];
  return typeof value === 'string' ? value : '';
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || '').split(';');
  for (const cookie of cookies) {
    const separator = cookie.indexOf('=');
    if (separator >= 0 && cookie.slice(0, separator).trim() === name) {
      return cookie.slice(separator + 1).trim();
    }
  }
  return '';
}

function sameValue(left, right) {
  const a = Buffer.from(left || '');
  const b = Buffer.from(right || '');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookie(name, value, path, maxAge = 600) {
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name, path) {
  return cookie(name, '', path, 0);
}

function redirect(res, url, cookies = []) {
  res.statusCode = 302;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('location', url);
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.end();
}

function authorizationUrl(endpoint, parameters) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams(parameters);
  return url.toString();
}

export async function verifyHandler(req, res) {
  try {
    requireEnvironment();
    const guildId = queryValue(req, 'guild_id');
    if (!/^\d{17,20}$/.test(guildId)) {
      return sendPage(res, 400, 'Open verification from Discord', '<h1>Open verification from Discord</h1><p>Start from the verification panel in the server you want to verify for.</p>');
    }
    const config = await getGuildConfig(guildId);
    if (!config) {
      return sendPage(res, 404, 'Server not configured', '<h1>Server not configured</h1><p>This server has not configured verification yet. Contact a server administrator.</p>');
    }
    const state = sealState({
      stage: 'discord',
      discordGuildId: config.guildId,
      csrf: random(32),
      exp: Date.now() + STATE_TTL_MS,
    });
    const url = authorizationUrl('https://discord.com/oauth2/authorize', {
      client_id: process.env.DISCORD_CLIENT_ID,
      redirect_uri: process.env.DISCORD_REDIRECT_URI,
      response_type: 'code',
      scope: 'identify',
      state,
    });
    redirect(res, url, [cookie(DISCORD_COOKIE, state, DISCORD_CALLBACK_PATH)]);
  } catch (error) {
    console.error('[verification] Could not start Discord sign-in:', error);
    sendPage(res, 503, 'Verification unavailable', '<h1>Verification unavailable</h1><p>The verification service is not configured correctly. Please contact a moderator.</p>');
  }
}

export async function discordCallbackHandler(req, res) {
  try {
    requireEnvironment();
    const stateValue = queryValue(req, 'state');
    const cookieState = readCookie(req, DISCORD_COOKIE);
    const clearStateCookie = clearCookie(DISCORD_COOKIE, DISCORD_CALLBACK_PATH);
    res.setHeader('set-cookie', clearStateCookie);
    if (!sameValue(stateValue, cookieState)) {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to Discord and start verification again in the same browser.</p>');
    }
    const state = openState(stateValue);
    if (!state || state.stage !== 'discord' || typeof state.csrf !== 'string') {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to Discord and start verification again.</p>');
    }
    if (queryValue(req, 'error')) {
      return sendPage(res, 400, 'Discord sign-in cancelled', '<h1>Sign-in cancelled</h1><p>No changes were made. Return to Discord to try again.</p>');
    }
    const code = queryValue(req, 'code');
    if (!code) {
      return sendPage(res, 400, 'Discord sign-in failed', '<h1>Discord sign-in failed</h1><p>Discord did not return a sign-in code. Start again from the verification panel.</p>');
    }

    const discordUserId = await exchangeDiscordCode(code);
    if (!/^\d{17,20}$/.test(state.discordGuildId)) {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to the server verification panel and start again.</p>');
    }
    const config = await getGuildConfig(state.discordGuildId);
    if (!config) {
      return sendPage(res, 404, 'Server not configured', '<h1>Server not configured</h1><p>This server no longer has verification configured.</p>');
    }
    const verifier = random(64);
    const robloxState = sealState({
      stage: 'roblox',
      discordUserId,
      discordGuildId: config.guildId,
      verifier,
      exp: Date.now() + STATE_TTL_MS,
    });
    const url = authorizationUrl('https://apis.roblox.com/oauth/v1/authorize', {
      client_id: process.env.ROBLOX_CLIENT_ID,
      redirect_uri: process.env.ROBLOX_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid profile',
      state: robloxState,
      code_challenge: challenge(verifier),
      code_challenge_method: 'S256',
    });
    redirect(res, url, [
      clearStateCookie,
      cookie(ROBLOX_COOKIE, robloxState, ROBLOX_CALLBACK_PATH),
    ]);
  } catch (error) {
    console.error('[verification] Discord OAuth callback failed:', error);
    sendPage(res, 502, 'Verification unavailable', '<h1>Verification unavailable</h1><p>We could not confirm your Discord account. Start again from the verification panel.</p>');
  }
}

export async function robloxCallbackHandler(req, res) {
  try {
    requireEnvironment();
    const stateValue = queryValue(req, 'state');
    const cookieState = readCookie(req, ROBLOX_COOKIE);
    const clearStateCookie = clearCookie(ROBLOX_COOKIE, ROBLOX_CALLBACK_PATH);
    res.setHeader('set-cookie', clearStateCookie);
    if (!sameValue(stateValue, cookieState)) {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to Discord and start verification again in the same browser.</p>');
    }

    const state = openState(stateValue);
    if (
      !state ||
      state.stage !== 'roblox' ||
      !/^\d{17,20}$/.test(state.discordUserId) ||
      !/^\d{17,20}$/.test(state.discordGuildId) ||
      typeof state.verifier !== 'string'
    ) {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in expired</h1><p>Return to Discord and start verification again.</p>');
    }
    if (queryValue(req, 'error')) {
      return sendPage(res, 400, 'Roblox sign-in cancelled', '<h1>Roblox sign-in cancelled</h1><p>No changes were made. Return to Discord to try again.</p>');
    }
    const code = queryValue(req, 'code');
    if (!code) {
      return sendPage(res, 400, 'Roblox sign-in failed', '<h1>Roblox sign-in failed</h1><p>Roblox did not return a sign-in code. Start again from the verification panel.</p>');
    }

    const config = await getGuildConfig(state.discordGuildId);
    if (!config) {
      return sendPage(res, 404, 'Server not configured', '<h1>Server not configured</h1><p>This server no longer has verification configured.</p>');
    }
    const profile = await exchangeRobloxCode(code, state.verifier);
    await saveVerificationLink({
      guildId: config.guildId,
      discordUserId: state.discordUserId,
      robloxUserId: profile.sub,
      robloxUsername: profile.preferred_username,
    });
    await assignVerifiedRole(config, state.discordUserId, profile.sub, profile.preferred_username);
    try {
      await recordVerificationStat(config.guildId, 'roblox');
    } catch (error) {
      console.error('[verification] Roblox verification succeeded, but its aggregate statistic could not be recorded:', error);
    }
    return sendPage(res, 200, 'Verification complete', '<h1>Verification complete</h1><p>Your Roblox account was verified and your Discord roles were updated. You can return to Discord.</p>');
  } catch (error) {
    console.error('[verification] Roblox OAuth callback failed:', error);
    return sendPage(res, 502, 'Verification unavailable', '<h1>Verification unavailable</h1><p>We could not complete verification. Please try again from Discord.</p>');
  }
}
