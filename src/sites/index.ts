import type { EndpointConfig } from '@directus/extensions';
import type {
  UsersService,
  AuthenticationService,
  ItemsService,
  MailService,
  SettingsService,
} from '@directus/api/services/index';
import { isDirectusError, InvalidPayloadError } from '@directus/errors';
import { DEFAULT_AUTH_PROVIDER } from '@directus/api/constants';
import type { Item, User } from '@directus/types';
import { getSecret } from '@directus/api/utils/get-secret';
import { getSimpleHash } from '@directus/utils';
import jwt from 'jsonwebtoken';
import { parse, stringify } from 'qs';

const fetchUserByEmail = async (users: UsersService, userEmail: string) => {
  const userData = await users.readByQuery({
    filter: {
      email: {
        _icontains: userEmail,
      },
    },
  });
  return userData[0] as User | undefined;
};

const endpoint: EndpointConfig = (router, ctx) => {
  const public_url = ctx.env['PUBLIC_URL'];

  router.post('/:siteId/token', async (req, res) => {
    const schema = await ctx.getSchema();
    const auth = new (ctx.services.AuthenticationService as typeof AuthenticationService)({ schema });
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });

    try {
      const body: any = parse(String(req.read()));

      const user = await fetchUserByEmail(users, body.username);
      if (!user || !user.role) {
        throw new InvalidPayloadError({ reason: 'User does not exist' });
      }

      const site = await sites.readOne(req.params['siteId']);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      const payload = {
        email: body.username,
        password: body.password,
        app_metadata: {
          git_provider: site['git_provider'],
          repo: site['repo'],
          access_token: site['access_token'],
        },
      };
      const result = await auth.login(DEFAULT_AUTH_PROVIDER, payload);

      const permissionsTestResponse = await fetch(`${public_url}/items/sites/${site['id']}`, {
        headers: {
          Authorization: `Bearer ${result.accessToken}`,
        },
      });
      const { data } = await permissionsTestResponse.json() as { data?: Item };

      if (!data?.['id']) {
        throw new InvalidPayloadError({ reason: "You don't have permission to access this site" });
      }

      return res.json({
        token_type: 'bearer',
        access_token: result.accessToken,
        expires_in: result.expires,
        refresh_token: result.refreshToken,
      });
    } catch (error) {
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: error.code,
          error_description: error.message,
        });
      } else {
        return res.status(500).json({
          error: (error as Error).name,
          error_description: (error as Error).message,
        });
      }
    }
  });

  router.get('/:siteId/user', async (req, res) => {
    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const maybeUserId = (req as any).accountability?.user;
    if (maybeUserId) {
      const user = await users.readOne(maybeUserId);
      const full_name = user['first_name'] ? `${user['first_name']} ${user['last_name']}` : undefined;
      const avatar_url = user['avatar'] ? `${public_url}/assets/${user['avatar']}?key=system-medium-cover` : undefined;
      return res.json({
        ...user,
        user_metadata: {
          full_name,
          avatar_url,
        },
        app_metadata: {
          provider: 'email',
        },
      });
    } else {
      return res.status(403).send('Unauthorized');
    }
  });

  router.post('/:siteId/invite', async (req, res) => {
    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', {
      schema,
      accountability: (req as any).accountability,
    });
    const collaborators = new (ctx.services.ItemsService as typeof ItemsService)('sites_directus_users', { schema });
    const mail = new (ctx.services.MailService as typeof MailService)({ schema });

    try {
      const { email, first_name, last_name, avatar } = req.body;
      if (!email) {
        throw new InvalidPayloadError({ reason: 'Missing "email" field in body' });
      }

      let invitedUser = await fetchUserByEmail(users, email);

      if (!invitedUser) {
        await users.createOne({
          email,
          first_name,
          last_name,
          avatar,
        });
      }

      invitedUser = await fetchUserByEmail(users, email);
      if (!invitedUser) {
        throw new Error('Could not create user.');
      }

      const maybeUserId = (req as any).accountability?.user;
      if (invitedUser.id === maybeUserId) {
        throw new InvalidPayloadError({ reason: 'Cannot invite yourself' });
      }

      const site = await sites.readOne(req.params['siteId']);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      const [maybeAlreadyInvited] = await collaborators.readByQuery({
        filter: {
          sites_id: { _eq: site['id'] },
          directus_users_id: { _eq: invitedUser['id'] },
        },
      });

      if (maybeAlreadyInvited) {
        throw new InvalidPayloadError({ reason: 'User was already invited' });
      }

      await collaborators.createOne({
        sites_id: site['id'],
        directus_users_id: invitedUser['id'],
      });

      const payload = { email: invitedUser.email, scope: 'password-reset', hash: getSimpleHash('null') };
      const token = jwt.sign(payload, getSecret(), { expiresIn: '30d', issuer: 'directus' });
      const queryParams = {
        user_id: invitedUser['id'],
        token,
      };
      const queryString = stringify(queryParams);
      const joinUrl = `${public_url}/sites/${site['id']}/join?${queryString}`;

      await mail.send({
        to: invitedUser['email'],
        subject: `You've been invited to contribute to the ${site['repo']} site.`,
        template: {
          name: 'user-invitation',
          data: {
            projectName: site['repo'],
            url: joinUrl,
          },
        },
      });

      return res.json({
        success: true,
      });
    } catch (error) {
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: error.code,
          error_description: error.message,
        });
      } else {
        return res.status(500).json({
          error: (error as Error).name,
          error_description: (error as Error).message,
        });
      }
    }
  });

  router.get('/:siteId/join', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });


    try {
      const site = await sites.readOne(req.params['siteId']);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      const userId = req.query['user_id'];
      if (typeof userId !== 'string') {
        throw new InvalidPayloadError({ reason: 'userId query parameter is missing or invalid' });
      }
      const token = req.query['token'];
      if (typeof token !== 'string') {
        throw new InvalidPayloadError({ reason: 'token query parameter is missing or invalid' });
      }

      const user = await users.readOne(userId) as User | undefined;
      if (!user) {
        throw new InvalidPayloadError({ reason: 'User does not exist' });
      }

      let redirectUrl = site['cms_url'];

      if (!user.password) {
        const { project_url } = await settings.readSingleton({});
        const queryParams = {
          token,
          site_id: site['id'],
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          avatar: user.avatar,
        };
        const queryString = stringify(queryParams);
        redirectUrl = `${project_url}/auth/finalize?${queryString}`;
      }

      return res.redirect(redirectUrl);
    } catch (error) {
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: error.code,
          error_description: error.message,
        });
      } else {
        return res.status(500).json({
          error: (error as Error).name,
          error_description: (error as Error).message,
        });
      }
    }
  });
};

export default endpoint;
