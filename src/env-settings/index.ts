import type { HookConfig } from '@directus/extensions';
import type { SettingsService, FilesService } from '@directus/api/services/index';

const settings = ['project_url', 'project_name', 'project_color'];

const hook: HookConfig = async ({ init }, ctx) => {
  init('cli.after', async () => {
    const payload: Record<string, string> = {};
    for (const key of settings) {
      const envKey = key.toUpperCase();
      if (ctx.env[envKey]) {
        payload[key] = ctx.env[envKey];
      }
    }

    const schema = await ctx.getSchema();
    const settingsService = new (ctx.services.SettingsService as typeof SettingsService)({ schema });

    if (ctx.env['PROJECT_LOGO']) {
      const current = await settingsService.readSingleton({});
      if (!current['project_logo']) {
        const filesService = new (ctx.services.FilesService as typeof FilesService)({ schema });
        const fileId = await filesService.importOne(ctx.env['PROJECT_LOGO'], { title: 'Project Logo' });
        payload['project_logo'] = String(fileId);
      }
    }

    if (Object.keys(payload).length === 0) return;
    await settingsService.upsertSingleton(payload);
    ctx.logger.info(`Directus settings updated: ${Object.keys(payload).join(', ')}`);
  });
};

export default hook;
