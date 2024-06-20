import type { EndpointConfig } from '@directus/extensions';
import type { UsersService, AuthenticationService, ItemsService } from '@directus/api/services/index';
import { type DirectusError, ForbiddenError } from '@directus/errors';
import { DEFAULT_AUTH_PROVIDER } from '@directus/api/constants';
import { parse } from 'qs';

const endpoint: EndpointConfig = (router, ctx) => {
  router.post('/:siteId/token', async (req, res) => {
    const schema = await ctx.getSchema();
    const auth = new (ctx.services.AuthenticationService as typeof AuthenticationService)({ schema });
    const items = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    try {
      const siteId = req.params['siteId'];
      const site = await items.readOne(siteId);
      if (!site) {
        throw new ForbiddenError();
      }
      const body: any = parse(String(req.read()));
      const payload = {
        email: body.username,
        password: body.password,
        app_metadata: {
          repo: site['repo'],
          access_token: site['access_token'],
        }
      };
      const result = await auth.login(DEFAULT_AUTH_PROVIDER, payload);
      return res.json({
        token_type: 'bearer',
        access_token: result.accessToken,
        expires_in: result.expires,
        refresh_token: result.refreshToken
      });
    } catch (err: any) {
      if (err.status && err.code) {
        const error = err as DirectusError
        return res.status(error.status).json({
          error: error.code,
          error_description: error.message
        });
      } else {
        const error = err as Error
        return res.status(500).json({
          error: error.name,
          error_description: error.message
        });
      }
    }
  });
  router.get('/:siteId/user', async (req, res) => {
    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const maybeUserId = (req as any).accountability?.user;
    if (maybeUserId) {
      const user = await users.readOne(maybeUserId)
      return res.json({
        ...user,
        user_metadata: {
          full_name: `${user['first_name']} ${user['last_name']}`,
          avatar_url: user['avatar']
        },
        app_metadata: {
          provider: "email"
        },
      });
    } else {
      return res.status(403).send('Unauthorized');
    }
  });
};

export default endpoint;
