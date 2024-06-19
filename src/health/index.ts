import type { EndpointConfig } from '@directus/extensions';
import type { ServerService, SettingsService } from '@directus/api/services/index';

const startTime = new Date();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const startedAt = `${new Date(startTime.getTime() - startTime.getTimezoneOffset() * 60000)
  .toISOString()
  .slice(0, 19)
  .replace('T', ' ')}`;

const endpoint: EndpointConfig = (router, ctx) => {
  router.get('/', async (_req, res) => {
    const schema = await ctx.getSchema();
    const server = new (ctx.services.ServerService as typeof ServerService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const health = await server.health();
    const { project } = await server.serverInfo();
    const { project_name } = project;
    const { project_url } = await settings.readSingleton({});
    return res.json({
      ...health,
      db_connection: 'ok',
      project_name,
      public_url: ctx.env['PUBLIC_URL'],
      project_url,
      started_at: startedAt,
      time_zone: timeZone,
      git_rev: ctx.env['GIT_REV']?.slice(0, 12),
    });
  });
};

export default endpoint;
