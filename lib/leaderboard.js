import crypto from 'node:crypto';
import { deleteArcadeScore, getArcadeScores, submitArcadeScore } from './guild-config.js';

function setHeaders(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-allow-headers', 'Content-Type');
  res.setHeader('cache-control', 'public, s-maxage=30, stale-while-revalidate=120');
}

export default async function leaderboardHandler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method)) {
    res.setHeader('allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (req.method !== 'GET') res.setHeader('cache-control', 'no-store');
  const game = typeof req.query?.game === 'string' ? req.query.game : req.body?.game;
  if (!['snake', 'reaction'].includes(game)) {
    return res.status(400).json({ error: 'Choose Snake or Reaction.' });
  }
  if (req.method === 'GET') {
    try {
      return res.status(200).json({ game, scores: await getArcadeScores(game) });
    } catch (error) {
      console.error('[leaderboard] Could not load scores:', error);
      return res.status(503).json({ error: 'Leaderboard is temporarily unavailable.' });
    }
  }
  const { alias, score, consent, manageToken } = req.body || {};
  if (typeof alias !== 'string' || !/^[A-Za-z0-9 _-]{2,20}$/.test(alias.trim())) {
    return res.status(400).json({ error: 'Alias must be 2-20 letters, numbers, spaces, underscores, or hyphens.' });
  }
  if (typeof manageToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(manageToken)) {
    return res.status(400).json({ error: 'A valid score management token is required.' });
  }
  const manageTokenHash = crypto.createHash('sha256').update(manageToken).digest('hex');
  if (req.method === 'DELETE') {
    try {
      if (!await deleteArcadeScore(game, alias, manageTokenHash)) {
        return res.status(404).json({ error: 'No score managed by this browser token was found.' });
      }
      return res.status(200).json({ deleted: true });
    } catch (error) {
      console.error('[leaderboard] Could not delete score:', error);
      return res.status(503).json({ error: 'Could not delete your score. Please try again later.' });
    }
  }
  if (consent !== true) return res.status(400).json({ error: 'Opt in before publishing your score.' });
  if (!Number.isInteger(score)
    || (game === 'snake' && (score < 0 || score > 3970 || score % 10 !== 0))
    || (game === 'reaction' && (score < 1 || score > 10_000))) {
    return res.status(400).json({ error: 'Score is outside the allowed range.' });
  }

  try {
    const saved = await submitArcadeScore(game, alias, score, manageTokenHash);
    if (!saved) {
      return res.status(409).json({ error: 'That alias is managed from another browser or device.' });
    }
    return res.status(200).json({ saved: true });
  } catch (error) {
    console.error('[leaderboard] Could not save score:', error);
    return res.status(503).json({ error: 'Could not save your score. Please try again later.' });
  }
}
