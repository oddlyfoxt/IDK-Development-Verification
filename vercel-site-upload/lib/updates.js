const UPDATE_CHANNEL_ID = '1571460007118119002';
const UPDATE_LIMIT = 5;

function responseHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type');
  res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
}

function publicAttachment(attachment) {
  if (typeof attachment.url !== 'string' || !attachment.url.startsWith('https://')) return null;
  return {
    name: typeof attachment.filename === 'string' ? attachment.filename.slice(0, 200) : 'Attachment',
    url: attachment.url,
    contentType: typeof attachment.content_type === 'string' ? attachment.content_type : '',
  };
}

export default async function updatesHandler(req, res) {
  responseHeaders(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!process.env.DISCORD_TOKEN) {
    return res.status(503).json({ error: 'Updates are temporarily unavailable.' });
  }

  try {
    const url = `https://discord.com/api/v10/channels/${UPDATE_CHANNEL_ID}/messages?limit=${UPDATE_LIMIT}`;
    const response = await fetch(url, {
      headers: { authorization: `Bot ${process.env.DISCORD_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      console.error(`[updates] Discord returned HTTP ${response.status} while reading the updates channel.`);
      return res.status(502).json({ error: 'Updates are temporarily unavailable.' });
    }

    const messages = await response.json();
    if (!Array.isArray(messages)) throw new Error('Discord returned an unexpected updates response');
    const updates = messages.map(message => ({
      id: message.id,
      author: message.author?.global_name || message.author?.username || 'Community member',
      timestamp: message.timestamp,
      content: typeof message.content === 'string' ? message.content.slice(0, 4000) : '',
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map(publicAttachment).filter(Boolean)
        : [],
    }));
    return res.status(200).json({ updates });
  } catch (error) {
    console.error('[updates] Could not load the Discord updates channel:', error);
    return res.status(502).json({ error: 'Updates are temporarily unavailable.' });
  }
}
