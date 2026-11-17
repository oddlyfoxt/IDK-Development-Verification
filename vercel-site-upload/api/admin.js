import {
  adminCallbackHandler,
  adminConfigHandler,
  adminGuildsHandler,
  adminLoginHandler,
  adminLogoutHandler,
  adminOptionsHandler,
  adminProfileHandler,
  adminSessionHandler,
  adminStatsHandler,
} from '../lib/admin.js';

const handlers = new Map([
  ['callback', adminCallbackHandler],
  ['config', adminConfigHandler],
  ['guilds', adminGuildsHandler],
  ['login', adminLoginHandler],
  ['logout', adminLogoutHandler],
  ['options', adminOptionsHandler],
  ['profile', adminProfileHandler],
  ['session', adminSessionHandler],
  ['stats', adminStatsHandler],
]);

export default function adminApiHandler(req, res) {
  const route = req.query?.__admin_route;
  const handler = typeof route === 'string' ? handlers.get(route) : undefined;
  if (!handler) return res.status(404).json({ error: 'Admin API route not found.' });
  return handler(req, res);
}
