import fs from 'fs';
import type { EndpointConfig } from '@directus/extensions';
import type { ServerService, SettingsService, ItemsService } from '@directus/api/services/index';

const getIsoTimeStamp = (date: Date) =>
  `${new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' ')}`;

const startTime = new Date();
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const startedAt = getIsoTimeStamp(startTime);

const endpoint: EndpointConfig = (router, ctx) => {
  router.get('/', async (_req, res) => {
    const schema = await ctx.getSchema();
    const server = new (ctx.services.ServerService as typeof ServerService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const migrations = new (ctx.services.ItemsService as typeof ItemsService)('directus_migrations', { schema });
    const health = await server.health();
    const { project } = await server.serverInfo();
    const { project_name } = project;
    const { project_url } = await settings.readSingleton({});
    const [last_migration] = await migrations.readByQuery({
      sort: ['-version'],
    });
    const now = getIsoTimeStamp(new Date());
    const packageJson = JSON.parse(fs.readFileSync(`${process.cwd()}/package.json`, { encoding: 'utf-8' }));

    return res.json({
      ...health,
      db_connection: 'ok',
      project_name,
      public_url: ctx.env['PUBLIC_URL'],
      project_url,
      started_at: startedAt,
      commit: ctx.env['SOURCE_COMMIT']?.slice(0, 12),
      version: packageJson['version'],
      directus_version: packageJson['dependencies']['directus'],
      last_migration_version: last_migration?.['version'],
      last_migration_time: last_migration?.['timestamp'],
      time_zone: timeZone,
      current_time: now,
    });
  });
};

export default endpoint;
