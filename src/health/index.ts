import type { EndpointConfig } from '@directus/extensions';
import type { ServerService, SettingsService } from '@directus/api/services/index';

const getIsoTimeStamp = (date: Date) => `${new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 19)
  .replace('T', ' ')}`

const startTime = new Date();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const startedAt = getIsoTimeStamp(startTime);

const endpoint: EndpointConfig = (router, ctx) => {
  router.get('/', async (_req, res) => {
    const schema = await ctx.getSchema();
    const server = new (ctx.services.ServerService as typeof ServerService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const health = await server.health();
    const { project } = await server.serverInfo();
    const { project_name } = project;
    const { project_url } = await settings.readSingleton({});
    const now = getIsoTimeStamp(new Date());

    return res.json({
      ...health,
      db_connection: 'ok',
      project_name,
      public_url: ctx.env['PUBLIC_URL'],
      project_url,
      started_at: startedAt,
      time_zone: timeZone,
      now: now,
      commit: ctx.env['SOURCE_COMMIT']?.slice(0, 12),
    });
  });
};

export default endpoint;
