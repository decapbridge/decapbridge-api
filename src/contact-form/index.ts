import type { EndpointConfig } from '@directus/extensions';
import type { MailService, SettingsService } from '@directus/api/services/index';
import { z } from 'zod';

const contactSchema = z.object({
  name: z.string(),
  email: z.string(),
  message: z.string(),
});

const endpoint: EndpointConfig = (router, ctx) => {
  router.post('/', async (req, res) => {
    try {
      console.log(req.body);
      const contact = contactSchema.parse(req.body);

      const adminEmail = ctx.env['ADMIN_EMAIL'];
      if (!adminEmail) {
        return res.status(500).json({ error: 'Missing ADMIN_EMAIL environment variable.' });
      }
      const schema = await ctx.getSchema();
      const mail = new (ctx.services.MailService as typeof MailService)({ schema });
      const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
      const { project_name, project_url } = await settings.readSingleton({});

      const subject = `Contact form message from ${contact.name}`;

      const html = `
        <p><b>Site:</b> <a target="_blank" href="${project_url}">${project_name}</a></p>
        <p><b>Name:</b> ${contact.name}</p>
        <p><b>Email:</b> ${contact.email}</p>
        <p><b>Message:</b></p>
        <p>${contact.message}</p>
      `;
      await mail.send({
        to: adminEmail,
        subject,
        html,
      });
      return res.json({ status: 'ok' });
    } catch (error) {
      if ((error as any).name === 'ZodError') {
        return res.status(400).json({ error });
      }
      return res.status(500).json({ error });
    }
  });
};

export default endpoint;
