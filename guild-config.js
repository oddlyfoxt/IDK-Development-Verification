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

async function request(path) {
  const { baseUrl, serviceKey } = databaseSettings();
  const response = await fetch(`${baseUrl}/rest/v1/${path}`, {
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
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
    select: 'guild_id,verified_role_id,unverified_role_id,panel_channel_id,log_channel_id',
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
  ) {
    throw new Error('Stored verification configuration is invalid');
  }

  return {
    guildId: row.guild_id,
    verifiedRoleId: row.verified_role_id,
    unverifiedRoleId: row.unverified_role_id,
    panelChannelId: row.panel_channel_id,
    logChannelId: row.log_channel_id,
  };
}
