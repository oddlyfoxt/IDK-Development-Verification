function getServiceStatus(name, url, headers = {}) {
  if (!url) return Promise.resolve({ name, status: 'unconfigured' });
  return fetch(url, { headers, signal: AbortSignal.timeout(5_000) })
    .then(response => ({ name, status: response.ok ? 'operational' : 'degraded' }))
    .catch(error => {
      console.error(`[status] ${name} health check failed:`, error);
      return { name, status: 'degraded' };
    });
}

export default async function statusHandler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=120');
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const checks = await Promise.all([
    getServiceStatus(
      'Discord',
      process.env.DISCORD_TOKEN ? 'https://discord.com/api/v10/users/@me' : '',
      process.env.DISCORD_TOKEN ? { authorization: `Bot ${process.env.DISCORD_TOKEN}` } : {},
    ),
    getServiceStatus(
      'Supabase',
      supabaseUrl && supabaseKey
        ? `${supabaseUrl.replace(/\/$/, '')}/rest/v1/verification_guilds?select=guild_id&limit=1`
        : '',
      supabaseKey ? { apikey: supabaseKey, authorization: `Bearer ${supabaseKey}` } : {},
    ),
    getServiceStatus('Roblox', 'https://apis.roblox.com/oauth/.well-known/openid-configuration'),
  ]);
  const overall = checks.every(check => check.status === 'operational') ? 'operational' : 'degraded';
  return res.status(200).json({ overall, checkedAt: new Date().toISOString(), services: checks });
}
