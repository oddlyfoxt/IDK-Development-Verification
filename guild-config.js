function databaseSettings() {
  const projectUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!projectUrl || !serviceKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  }

  let baseUrl;
  try {
    baseUrl = new URL(projectUrl);
  } catch {
    throw new Error('SUPABASE_URL must be an absolute HTTPS URL');
  }
  if (baseUrl.protocol !== 'https:') throw new Error('SUPABASE_URL must use HTTPS');
  return { baseUrl: baseUrl.toString().replace(/\/$/, ''), serviceKey };
}

function isSnowflake(value) {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

async function request(path, options = {}) {
  const { baseUrl, serviceKey } = databaseSettings();
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Supabase configuration request failed with HTTP ${response.status}`);
  }
  return response;
}

export async function getGuildConfig(guildId) {
  if (!isSnowflake(guildId)) throw new Error('Invalid Discord server ID');
  const query = new URLSearchParams({
    select: 'guild_id,verified_role_id,unverified_role_id,panel_channel_id,log_channel_id,panel_title,panel_description,panel_color',
    guild_id: `eq.${guildId}`,
  });
  const response = await request(`verification_guilds?${query}`);
  const [row] = await response.json();
  if (!row) return null;
  if (row.guild_id !== guildId) throw new Error('Stored verification configuration does not match the requested server');

  if (
    !isSnowflake(row.guild_id)
    || !isSnowflake(row.verified_role_id)
    || !isSnowflake(row.panel_channel_id)
    || !isSnowflake(row.log_channel_id)
    || (row.unverified_role_id !== null && !isSnowflake(row.unverified_role_id))
    || row.unverified_role_id === row.verified_role_id
    || typeof row.panel_title !== 'string'
    || row.panel_title.length < 1
    || row.panel_title.length > 80
    || typeof row.panel_description !== 'string'
    || row.panel_description.length < 1
    || row.panel_description.length > 500
    || typeof row.panel_color !== 'string'
    || !/^#[0-9A-Fa-f]{6}$/.test(row.panel_color)
  ) {
    throw new Error('Stored verification configuration is invalid');
  }

  return {
    guildId: row.guild_id,
    verifiedRoleId: row.verified_role_id,
    unverifiedRoleId: row.unverified_role_id,
    panelChannelId: row.panel_channel_id,
    logChannelId: row.log_channel_id,
    panelTitle: row.panel_title,
    panelDescription: row.panel_description,
    panelColor: row.panel_color,
  };
}

export async function saveGuildConfig(config) {
  if (
    !config
    || !isSnowflake(config.guildId)
    || !isSnowflake(config.verifiedRoleId)
    || !isSnowflake(config.panelChannelId)
    || !isSnowflake(config.logChannelId)
    || (config.unverifiedRoleId !== null && !isSnowflake(config.unverifiedRoleId))
    || config.unverifiedRoleId === config.verifiedRoleId
    || typeof config.panelTitle !== 'string'
    || config.panelTitle.length < 1
    || config.panelTitle.length > 80
    || typeof config.panelDescription !== 'string'
    || config.panelDescription.length < 1
    || config.panelDescription.length > 500
    || typeof config.panelColor !== 'string'
    || !/^#[0-9A-Fa-f]{6}$/.test(config.panelColor)
  ) {
    throw new Error('Invalid server verification configuration');
  }
  return request('verification_guilds?on_conflict=guild_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      guild_id: config.guildId,
      verified_role_id: config.verifiedRoleId,
      unverified_role_id: config.unverifiedRoleId,
      panel_channel_id: config.panelChannelId,
      log_channel_id: config.logChannelId,
      panel_title: config.panelTitle,
      panel_description: config.panelDescription,
      panel_color: config.panelColor,
    }),
  });
}

export async function recordVerificationStat(guildId, method) {
  if (!isSnowflake(guildId)) throw new Error('Invalid Discord server ID');
  if (!['captcha', 'roblox'].includes(method)) throw new Error('Invalid verification method');
  return request('rpc/record_verification_stat', {
    method: 'POST',
    body: JSON.stringify({ p_guild_id: guildId, p_method: method }),
  });
}

export async function saveVerificationLink({ guildId, discordUserId, robloxUserId, robloxUsername }) {
  if (!isSnowflake(guildId) || !isSnowflake(discordUserId) || !/^\d+$/.test(String(robloxUserId))) {
    throw new Error('Invalid Discord or Roblox account ID');
  }
  if (typeof robloxUsername !== 'string' || !/^[A-Za-z0-9_]{3,20}$/.test(robloxUsername)) {
    throw new Error('Invalid Roblox username');
  }
  return request('verification_links?on_conflict=guild_id,discord_user_id', {
    method: 'POST',
    headers: { prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      guild_id: guildId,
      discord_user_id: discordUserId,
      roblox_user_id: String(robloxUserId),
      roblox_username: robloxUsername,
    }),
  });
}

export async function deleteVerificationLink(guildId, discordUserId) {
  if (!isSnowflake(guildId) || !isSnowflake(discordUserId)) {
    throw new Error('Invalid Discord server or user ID');
  }
  const query = new URLSearchParams({
    guild_id: `eq.${guildId}`,
    discord_user_id: `eq.${discordUserId}`,
  });
  const response = await request(`verification_links?${query}`, {
    method: 'DELETE',
    headers: { prefer: 'return=representation' },
  });
  const rows = await response.json();
  return Array.isArray(rows) && rows.length > 0;
}

export async function getVerificationStats(guildId, days = 30) {
  if (!isSnowflake(guildId)) throw new Error('Invalid Discord server ID');
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('Stats range must be between 1 and 90 days');
  const since = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const query = new URLSearchParams({
    select: 'verification_day,method,total',
    guild_id: `eq.${guildId}`,
    verification_day: `gte.${since}`,
    order: 'verification_day.asc',
  });
  const response = await request(`verification_stats_daily?${query}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Supabase returned invalid verification statistics');
  return rows;
}

export async function getArcadeScores(game) {
  if (!['snake', 'reaction'].includes(game)) throw new Error('Invalid arcade game');
  const query = new URLSearchParams({
    select: 'alias,score,updated_at',
    game: `eq.${game}`,
    order: game === 'snake' ? 'score.desc' : 'score.asc',
    limit: '10',
  });
  const response = await request(`arcade_scores?${query}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Supabase returned invalid arcade scores');
  return rows;
}

export async function submitArcadeScore(game, alias, score, manageTokenHash) {
  if (!['snake', 'reaction'].includes(game)) throw new Error('Invalid arcade game');
  if (typeof alias !== 'string' || !/^[A-Za-z0-9 _-]{2,20}$/.test(alias.trim())) {
    throw new Error('Alias must be 2-20 letters, numbers, spaces, underscores, or hyphens');
  }
  if (typeof manageTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(manageTokenHash)) {
    throw new Error('Invalid arcade score management token');
  }
  if (!Number.isInteger(score)
    || (game === 'snake' && (score < 0 || score > 3970 || score % 10 !== 0))
    || (game === 'reaction' && (score < 1 || score > 10_000))) {
    throw new Error('Score is outside the allowed range');
  }
  const response = await request('rpc/submit_arcade_score', {
    method: 'POST',
    body: JSON.stringify({
      p_game: game,
      p_alias: alias.trim(),
      p_score: score,
      p_manage_token_hash: manageTokenHash,
    }),
  });
  return response.json();
}

export async function deleteArcadeScore(game, alias, manageTokenHash) {
  if (!['snake', 'reaction'].includes(game)) throw new Error('Invalid arcade game');
  if (typeof alias !== 'string' || !/^[A-Za-z0-9 _-]{2,20}$/.test(alias.trim())) {
    throw new Error('Alias must be 2-20 letters, numbers, spaces, underscores, or hyphens');
  }
  if (typeof manageTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(manageTokenHash)) {
    throw new Error('Invalid arcade score management token');
  }
  const response = await request('rpc/delete_arcade_score', {
    method: 'POST',
    body: JSON.stringify({
      p_game: game,
      p_alias: alias.trim(),
      p_manage_token_hash: manageTokenHash,
    }),
  });
  return response.json();
}
