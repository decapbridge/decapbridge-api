import type { EndpointConfig } from '@directus/extensions';
import type {
  UsersService,
  AuthenticationService,
  ItemsService,
  MailService,
  SettingsService,
} from '@directus/api/services/index';
import { isDirectusError, InvalidPayloadError, InvalidTokenError, InvalidCredentialsError } from '@directus/errors';
import { DEFAULT_AUTH_PROVIDER } from '@directus/api/constants';
import type { Item, LoginResult, User } from '@directus/types';
import { getSecret } from '@directus/api/utils/get-secret';
import { verifyAccessJWT } from '@directus/api/utils/jwt';
import isDirectusJWT from '@directus/api/utils/is-directus-jwt';
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

      const site = await sites.readOne(req.params['siteId']);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      let user: User;
      if (body.code) {
        const record = await ctx.database.select('user').from('directus_sessions').where('token', body.code).first();
        if (!record?.user) {
          throw new InvalidCredentialsError();
        }
        user = (await users.readOne(record.user)) as User;
      } else if (body.username && body.password) {
        const [maybeUser] = (await users.readByQuery({
          filter: {
            email: {
              _eq: body.username,
            },
          },
        })) as User[];
        if (!maybeUser) {
          throw new InvalidPayloadError({ reason: 'User does not exist' });
        }
        user = maybeUser;
      } else {
        throw new InvalidPayloadError({ reason: 'Missing "username", "password" or "code" field.' });
      }

      const full_name = user['first_name'] ? `${user['first_name']} ${user['last_name']}` : undefined;
      const avatar_url = user['avatar'] ? `${public_url}/assets/${user['avatar']}?key=system-medium-cover` : undefined;
      const userData = {
        email: user['email'],
        first_name: user['first_name'],
        last_name: user['last_name'],
        full_name: full_name,
        avatar_url: avatar_url,
      };

      const loginOptions = {
        claims: userData,
        app_metadata: {
          git_provider: site['git_provider'],
          repo: site['repo'],
          access_token: site['access_token'],
        },
      } as any;

      let loginResult: LoginResult;
      if (body.code) {
        loginResult = await auth.refresh(body.code, loginOptions);
      } else if (body.username && body.password) {
        loginResult = await auth.login(
          DEFAULT_AUTH_PROVIDER,
          { email: body.username, password: body.password },
          loginOptions
        );
      } else {
        throw new InvalidPayloadError({ reason: 'Missing "username", "password" or "code" field.' });
      }

      const permissionsTestResponse = await fetch(`${public_url}/items/sites/${site['id']}`, {
        headers: {
          Authorization: `Bearer ${loginResult.accessToken}`,
        },
      });
      const { data } = (await permissionsTestResponse.json()) as { data?: Item };
      if (!data?.['id']) {
        throw new InvalidPayloadError({ reason: "You don't have permission to access this site" });
      }

      return res.json({
        ...userData,
        token_type: 'bearer',
        access_token: loginResult.accessToken,
        expires_in: loginResult.expires,
        refresh_token: loginResult.refreshToken,
        user_metadata: userData,
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

  router.get('/:siteId/pkce', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });

    const site = await sites.readOne(req.params['siteId']);
    if (!site) {
      throw new InvalidPayloadError({ reason: 'Site does not exist' });
    }

    const site_name = site['repo'].split('/')[1];

    const { project_url } = await settings.readSingleton({});

    return res.redirect(
      `${project_url}/auth/login?site_id=${req.params.siteId}&site_name=${site_name}&state=${encodeURIComponent(
        String(req.query['state'])
      )}&redirect_uri=${req.query['redirect_uri']}`
    );
  });

  router.get('/:siteId/sso-callback', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });

    try {
      const { project_url } = await settings.readSingleton({});
      if (req.query['reason']) {
        // TODO there's missing params in the URL here...
        return res.redirect(`${project_url}/auth/login?error=${req.query['reason']}`);
      }

      const site = await sites.readOne(req.params['siteId']);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      if (!req.query['state']) {
        throw new InvalidPayloadError({ reason: 'Missing "state" field in query parameters.' });
      }

      const token = req.cookies[ctx.env['SESSION_COOKIE_NAME'] as string];
      if (!isDirectusJWT(token)) {
        throw new InvalidTokenError();
      }
      const payload = verifyAccessJWT(token, getSecret());
      const refreshToken = payload.session;
      if (!refreshToken) {
        throw new InvalidTokenError();
      }

      // Remove the token from the session

      const cmsUrl = `${site['cms_url']}?state=${req.query['state']}&code=${refreshToken}`;
      return res.clearCookie(ctx.env['SESSION_COOKIE_NAME']).redirect(cmsUrl);
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
          ...user,
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
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });

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

      const { project_url } = await settings.readSingleton({});
      const forgotPassword = `${project_url}/auth/password/forgot?email=${encodeURIComponent(invitedUser['email']!)}`;
      const siteName = site['repo'].split('/')[1];


      await mail.send({
        to: invitedUser['email']!,
        subject: `You've been invited to ${siteName}`,
        template: {
          name: 'site-invitation',
          data: {
            projectName: siteName,
            url: joinUrl,
            forgotPassword,
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

      const site_name = site['repo'].split('/')[1];

      const userId = req.query['user_id'];
      if (typeof userId !== 'string') {
        throw new InvalidPayloadError({ reason: 'userId query parameter is missing or invalid' });
      }
      const token = req.query['token'];
      if (typeof token !== 'string') {
        throw new InvalidPayloadError({ reason: 'token query parameter is missing or invalid' });
      }

      const user = (await users.readOne(userId)) as User | undefined;
      if (!user) {
        throw new InvalidPayloadError({ reason: 'User does not exist' });
      }

      let redirectUrl = site['cms_url'];

      const isFirstLogin = user.provider === 'default' && !user.password;
      const needsToSetPassword = site['auth_type'] === 'classic' && !user.password;

      if (isFirstLogin || needsToSetPassword) {
        const { project_url } = await settings.readSingleton({});
        const queryParams = {
          token,
          site_id: site['id'],
          site_name: site_name,
          redirect_uri: redirectUrl,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          avatar: user.avatar,
          auth_type: site['auth_type'],
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
