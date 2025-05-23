import type { HookConfig } from '@directus/extensions';
import type { MailService, SettingsService } from '@directus/api/services/index';

const hook: HookConfig = async ({ action }, ctx) => {
  const adminEmail = ctx.env['ADMIN_EMAIL'];
  const publicUrl = String(ctx.env['PUBLIC_URL']);
  if (adminEmail) {
    const schema = await ctx.getSchema();
    const mail = new (ctx.services.MailService as typeof MailService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const { project_name } = await settings.readSingleton({});
    action('users.create', async ({ payload }, { accountability }) => {
      ctx.logger.info(`User ${payload.email} just signed up.`);
      if (payload.email !== adminEmail && !publicUrl.includes('localhost') && !accountability?.user) {
        await mail.send({
          to: adminEmail,
          subject: `A new user just signed up to ${project_name}`,
          text: `Email: ${payload.email}`,
        });
      }
    });
  }
};

export default hook;
