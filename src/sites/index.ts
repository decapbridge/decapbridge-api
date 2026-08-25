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
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { parse, stringify } from 'qs';

const FREE_COLLABORATORS_LIMIT = 10;

const fetchUserByEmail = async (users: UsersService, userEmail: string): Promise<User | undefined> => {
  const results = await users.readByQuery({
    filter: {
      email: {
        _icontains: userEmail, // Directus doesn't have _ieq
      },
    },
  });
  // _icontains is a substring match, so filter to exact (case-insensitive) matches
  const foundUser = (results as User[]).find(
    (u) => u.email?.toLowerCase() === userEmail.toLowerCase()
  );
  return foundUser;
};

// gotrue posts the /token body as application/x-www-form-urlencoded, which Directus's global
// express.json() leaves unparsed. We must read the raw stream ourselves — but a synchronous
// req.read() returns null when the body isn't buffered yet, intermittently dropping the payload.
// Await the stream instead so the body is read reliably every time.
const readRawBody = (req: any): Promise<string> =>
  new Promise((resolve, reject) => {
    if (req.readableEnded) {
      resolve('');
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });


// Build the redirect back to the CMS after SSO. Prefer the redirect_uri the CMS itself sent
// (Decap's own origin+pathname), but only when it matches the stored cms_url's origin, to
// avoid an open redirect. Use the URL API so query params land before any #fragment in
// cms_url (e.g. "https://site.com/admin/#/") -- Decap only reads location.search.
const buildCmsRedirect = (cmsUrl: string, requestedUri: unknown, params: Record<string, string>) => {
  try {
    let url = new URL(cmsUrl);
    if (typeof requestedUri === 'string' && requestedUri) {
      try {
        const requested = new URL(requestedUri);
        if (requested.origin === url.origin) {
          url = requested;
        }
      } catch {
        // ignore malformed redirect_uri
      }
    }
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.href;
  } catch {
    // cms_url isn't a valid URL -- fall back to the legacy concatenation
    return `${cmsUrl}?${new URLSearchParams(params)}`;
  }
};

const testSitePermissions = async (public_url: string, siteId: string, token: string) => {
  const permissionsTestResponse = await fetch(`${public_url}/items/sites/${siteId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  const { data } = (await permissionsTestResponse.json()) as { data?: Item };
  if (!data?.['id']) {
    throw new InvalidPayloadError({ reason: "You don't have permission to access this site" });
  }
};

const endpoint: EndpointConfig = (router, ctx) => {
  const public_url = ctx.env['PUBLIC_URL'];

  // Shared error handling. Logs at debug so the failing `stage` surfaces under LOG_LEVEL=debug
  // without adding noise at the default level, then responds in the route's native format.
  type ErrorLog = { route: string; siteId?: string; stage?: string };

  const sendError = (res: any, error: unknown, log: ErrorLog) => {
    ctx.logger.debug({ ...log, err: error }, `${log.route} failed`);
    if (isDirectusError(error)) {
      return res.status(error.status).json({ error: error.code, error_description: error.message });
    }
    return res.status(500).json({ error: (error as Error).name, error_description: (error as Error).message });
  };

  // For the auth-redirect routes (pkce, sso-callback): log the failure, then bounce the
  // browser to a URL the caller computes (login page or CMS, with the error in the query string).
  const sendRedirectError = (res: any, error: unknown, redirectUrl: string, log: ErrorLog) => {
    ctx.logger.debug({ ...log, err: error }, `${log.route} failed`);
    return res.redirect(redirectUrl);
  };

  router.post('/:siteId/token', async (req, res) => {
    const schema = await ctx.getSchema();
    const auth = new (ctx.services.AuthenticationService as typeof AuthenticationService)({ schema });
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const siteId = req.params['siteId'];

    // Tracks how far token issuance progressed, so failures can be pinpointed at LOG_LEVEL=debug.
    let stage = 'parse-body';

    try {
      // Prefer a body Directus already parsed (JSON); otherwise read the urlencoded gotrue payload.
      const body: any =
        req.body && Object.keys(req.body).length ? req.body : parse(await readRawBody(req));
      const grantType = body.code ? 'code' : body.username && body.password ? 'password' : 'unknown';
      ctx.logger.debug({ siteId, grantType, contentType: req.headers['content-type'] }, 'Token request received');

      stage = 'load-site';
      const site = await sites.readOne(siteId);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      let user: User;
      if (body.code) {
        stage = 'resolve-session';
        const record = await ctx.database.select('user').from('directus_sessions').where('token', body.code).first();
        if (!record?.user) {
          ctx.logger.debug({ siteId }, 'No active session matches the provided code');
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
        stage = 'refresh-token';
        // Refreshing rotates the token in place, which would kill the dashboard session that was
        // handed over as the PKCE code. Fork it into a separate session for the CMS instead.
        const cmsToken = crypto.randomBytes(48).toString('base64url');
        await ctx.database('directus_sessions').insert({
          ...(await ctx.database.select('*').from('directus_sessions').where('token', body.code).first()),
          token: cmsToken,
          next_token: null,
        });
        loginResult = await auth.refresh(cmsToken, loginOptions);
      } else if (body.username && body.password) {
        stage = 'login';
        loginResult = await auth.login(
          DEFAULT_AUTH_PROVIDER,
          { email: body.username, password: body.password },
          loginOptions,
        );
      } else {
        throw new InvalidPayloadError({ reason: 'Missing "username", "password" or "code" field.' });
      }

      stage = 'verify-site-access';
      await testSitePermissions(public_url, site['id'], loginResult.accessToken);

      ctx.logger.debug({ siteId, userId: user['id'] }, 'Issued access token');
      return res.json({
        ...userData,
        token_type: 'bearer',
        access_token: loginResult.accessToken,
        expires_in: loginResult.expires,
        refresh_token: loginResult.refreshToken,
        user_metadata: userData,
      });
    } catch (error) {
      return sendError(res, error, { route: 'token', siteId, stage });
    }
  });

  router.get('/:siteId/pkce', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const { project_url } = await settings.readSingleton({});
    const siteId = req.params['siteId'];

    try {
      const site = await sites.readOne(siteId);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      const queryParams: any = {
        site_id: site['id'],
        site_name: site['name'] || site['repo'].split('/')[1],
        state: String(req.query['state']),
        redirect_uri: req.query['redirect_uri'],
      };
      if (site['logo']) {
        queryParams['site_logo'] = `${public_url}/assets/${site['logo']}`;
      }
      if (site['color']) {
        queryParams['site_color'] = site['color'];
      }

      const queryString = stringify(queryParams);
      return res.redirect(`${project_url}/auth/login?${queryString}`);
    } catch (error) {
      const redirectUrl = `${project_url}/auth/login?error=${encodeURIComponent((error as Error).message)}`;
      return sendRedirectError(res, error, redirectUrl, { route: 'pkce', siteId });
    }
  });

  router.get('/:siteId/sso-callback', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const { project_url } = await settings.readSingleton({});
    const siteId = req.params['siteId'];
    let stage = 'load-site';

    try {
      if (req.query['reason']) {
        // TODO there's missing params in the URL here...
        return res.redirect(`${project_url}/auth/login?error=${req.query['reason']}`);
      }

      const site = await sites.readOne(siteId);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      if (!req.query['state']) {
        throw new InvalidPayloadError({ reason: 'Missing "state" field in query parameters.' });
      }

      try {
        stage = 'verify-site-access';
        const token = req.cookies[ctx.env['SESSION_COOKIE_NAME'] as string];

        await testSitePermissions(public_url, site['id'], token);

        // Exchange cookie for jwt
        stage = 'verify-jwt';
        if (!isDirectusJWT(token)) {
          throw new InvalidTokenError();
        }
        const payload = verifyAccessJWT(token, getSecret());
        const refreshToken = payload.session;
        if (!refreshToken) {
          throw new InvalidTokenError();
        }

        // TODO: Remove the token from the session?

        const cmsUrl = buildCmsRedirect(site['cms_url'], req.query['redirect_uri'], {
          state: String(req.query['state']),
          code: refreshToken,
        });
        return res.clearCookie(ctx.env['SESSION_COOKIE_NAME']).redirect(cmsUrl);
      } catch (error) {
        const [errMsg, errDesc] = (error as Error).message.split('.');
        const redirectUrl = buildCmsRedirect(site['cms_url'], req.query['redirect_uri'], {
          state: String(req.query['state']),
          error: errMsg ?? '',
          error_description: errDesc ?? '',
        });
        return sendRedirectError(res, error, redirectUrl, { route: 'sso-callback', siteId, stage });
      }
    } catch (error) {
      const redirectUrl = `${project_url}/auth/login?error=${(error as Error).message}`;
      return sendRedirectError(res, error, redirectUrl, { route: 'sso-callback', siteId, stage });
    }
  });

  router.get('/:siteId/user', async (req, res) => {
    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const maybeUserId = (req as any).accountability?.user;
    const siteId = req.params['siteId'];
    try {
      if (maybeUserId) {
        const user = await users.readOne(maybeUserId);
        const full_name = user['first_name'] ? `${user['first_name']} ${user['last_name']}` : undefined;
        const avatar_url = user['avatar']
          ? `${public_url}/assets/${user['avatar']}?key=system-medium-cover`
          : undefined;
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
    } catch (error) {
      return sendError(res, error, { route: 'user', siteId });
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
    const siteId = req.params['siteId'];
    let stage = 'validate-input';

    try {
      const { email, first_name, last_name, avatar } = req.body;
      if (!email) {
        throw new InvalidPayloadError({ reason: 'Missing "email" field in body' });
      }

      stage = 'resolve-invited-user';
      let invitedUser = await fetchUserByEmail(users, email);

      if (!invitedUser) {
        await users.createOne({
          email: email.toLowerCase(),
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

      stage = 'authorize-caller';
      const site = await sites.readOne(siteId);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      const isOwner = site['user_created'] === maybeUserId;
      let isAdmin = false;
      if (!isOwner && maybeUserId) {
        const [adminRow] = await collaborators.readByQuery({
          filter: {
            sites_id: { _eq: site['id'] },
            directus_users_id: { _eq: maybeUserId },
            role: { _eq: 'admin' },
          },
          limit: 1,
        });
        isAdmin = Boolean(adminRow);
      }
      if (!isOwner && !isAdmin) {
        throw new InvalidPayloadError({ reason: 'Only the site owner or an admin can invite collaborators' });
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

      // Enforce free account collaborator limit
      stage = 'enforce-limit';
      const siteOwner = await users.readOne(site['user_created'], { fields: ['stripe_subscription_status'] });
      if (siteOwner['stripe_subscription_status'] !== 'active') {
        const existingCollaborators = await collaborators.readByQuery({
          filter: { sites_id: { _eq: site['id'] } },
          aggregate: { count: ['id'] },
        });
        const totalUsers = Number(existingCollaborators[0]?.['count']?.['id'] ?? 0) + 1; // +1 for owner
        if (totalUsers >= FREE_COLLABORATORS_LIMIT) {
          throw new InvalidPayloadError({
            reason: `Free accounts are limited to ${FREE_COLLABORATORS_LIMIT} collaborators per site. Please upgrade your plan to invite more collaborators.`,
          });
        }
      }

      stage = 'create-collaborator';
      const payload = { email: invitedUser.email, scope: 'password-reset', hash: getSimpleHash('null') };
      const token = jwt.sign(payload, getSecret(), { expiresIn: '30d', issuer: 'directus' });

      await collaborators.createOne({
        sites_id: site['id'],
        directus_users_id: invitedUser['id'],
        invite_token: token,
      });
      const queryParams = {
        user_id: invitedUser['id'],
        token,
      };
      const queryString = stringify(queryParams);
      const joinUrl = `${public_url}/sites/${site['id']}/join?${queryString}`;

      const { project_url } = await settings.readSingleton({});
      const forgotPassword = `${project_url}/auth/password/forgot?email=${encodeURIComponent(invitedUser['email']!)}`;
      const projectName = site['name'] || site['repo'].split('/')[1];

      const mailData: any = {
        projectName,
        url: joinUrl,
        forgotPassword,
      };
      if (site['logo']) {
        mailData['projectLogo'] = `${public_url}/assets/${site['logo']}`;
      }
      if (site['color']) {
        mailData['projectColor'] = site['color'];
      }

      let emailSent = false;
      if (ctx.env['EMAIL_FROM']) {
        try {
          await mail.send({
            to: invitedUser['email']!,
            subject: `You've been invited to ${projectName}`,
            template: {
              name: 'site-invitation',
              data: mailData,
            },
          });
          emailSent = true;
        } catch (err) {
          ctx.logger.warn(`Failed to send invitation email to ${invitedUser['email']}: ${(err as Error).message}`);
        }
      } else {
        ctx.logger.debug('Email not configured (EMAIL_FROM not set), skipping invitation email');
      }

      return res.json({
        success: true,
        token,
        emailSent,
      });
    } catch (error) {
      return sendError(res, error, { route: 'invite', siteId, stage });
    }
  });

  router.get('/:siteId/join', async (req, res) => {
    const schema = await ctx.getSchema();
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const collaborators = new (ctx.services.ItemsService as typeof ItemsService)('sites_directus_users', { schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const siteId = req.params['siteId'];
    let stage = 'load-site';

    try {
      const site = await sites.readOne(siteId);
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

      const user = (await users.readOne(userId)) as User | undefined;
      if (!user) {
        throw new InvalidPayloadError({ reason: 'User does not exist' });
      }

      // Validate and clear the invite token
      stage = 'validate-invite-token';
      const [collaboratorRecord] = await collaborators.readByQuery({
        filter: {
          sites_id: { _eq: site['id'] },
          directus_users_id: { _eq: userId },
        },
      });
      if (!collaboratorRecord || collaboratorRecord['invite_token'] !== token) {
        throw new InvalidPayloadError({ reason: 'Invalid or expired invite token' });
      }
      await collaborators.updateOne(collaboratorRecord['id'], { invite_token: null });

      let redirectUrl = site['cms_url'];

      const isFirstLogin = user.provider === 'default' && !user.password;
      const needsToSetPassword = site['auth_type'] === 'classic' && !user.password;

      if (isFirstLogin || needsToSetPassword) {
        const { project_url } = await settings.readSingleton({});
        const queryParams: any = {
          token,
          site_id: site['id'],
          site_name: site['name'] || site['repo'].split('/')[1],
          redirect_uri: redirectUrl,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          avatar: user.avatar,
          auth_type: site['auth_type'],
        };
        if (site['logo']) {
          queryParams['site_logo'] = `${public_url}/assets/${site['logo']}`;
        }
        if (site['color']) {
          queryParams['site_color'] = site['color'];
        }
        const queryString = stringify(queryParams);
        redirectUrl = `${project_url}/auth/finalize?${queryString}`;
      }

      return res.redirect(redirectUrl);
    } catch (error) {
      return sendError(res, error, { route: 'join', siteId, stage });
    }
  });

  router.post('/:siteId/transfer-ownership', async (req, res) => {
    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', {
      schema,
      accountability: (req as any).accountability,
    });
    const collaborators = new (ctx.services.ItemsService as typeof ItemsService)('sites_directus_users', { schema });
    const mail = new (ctx.services.MailService as typeof MailService)({ schema });
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    const siteId = req.params['siteId'];
    let stage = 'validate-input';

    try {
      const callerId = (req as any).accountability?.user;
      if (!callerId) {
        throw new InvalidPayloadError({ reason: 'Authentication required' });
      }

      const { email } = req.body ?? {};
      if (!email || typeof email !== 'string') {
        throw new InvalidPayloadError({ reason: 'Missing or invalid "email" field in body' });
      }

      stage = 'authorize-owner';
      const site = await sites.readOne(siteId);
      if (!site) {
        throw new InvalidPayloadError({ reason: 'Site does not exist' });
      }

      if (site['user_created'] !== callerId) {
        throw new InvalidPayloadError({ reason: 'Only the site owner can transfer ownership' });
      }

      const recipient = await fetchUserByEmail(users, email);
      if (!recipient) {
        throw new InvalidPayloadError({ reason: 'No user found with that email' });
      }

      if (recipient.id === callerId) {
        throw new InvalidPayloadError({ reason: 'You are already the owner of this site' });
      }

      const [collaboratorRow] = await collaborators.readByQuery({
        filter: {
          sites_id: { _eq: site['id'] },
          directus_users_id: { _eq: recipient.id },
        },
        limit: 1,
      });

      if (!collaboratorRow) {
        throw new InvalidPayloadError({
          reason: 'User must be a collaborator on this site before becoming owner',
        });
      }

      stage = 'transfer';
      await ctx.database.transaction(async (trx) => {
        await trx('sites_directus_users')
          .where({ id: collaboratorRow['id'] })
          .update({ directus_users_id: callerId, invite_token: null });
        await trx('sites').where({ id: site['id'] }).update({ user_created: recipient.id });
      });

      const projectName = site['name'] || site['repo'].split('/')[1];
      const oldOwner = (await users.readOne(callerId, { fields: ['email', 'first_name'] })) as User;

      if (ctx.env['EMAIL_FROM']) {
        try {
          await mail.send({
            to: oldOwner['email']!,
            subject: `Ownership of ${projectName} was transferred`,
            text: `Hi${oldOwner['first_name'] ? ' ' + oldOwner['first_name'] : ''},\n\nOwnership of ${projectName} was transferred to ${recipient.email}. You remain a collaborator on the site. If this wasn't you, contact support immediately.\n`,
          });
        } catch (err) {
          ctx.logger.warn(`Failed to send transfer email to old owner: ${(err as Error).message}`);
        }

        try {
          const { project_url } = await settings.readSingleton({});
          await mail.send({
            to: recipient.email!,
            subject: `You are now the owner of ${projectName}`,
            text: `Hi${recipient.first_name ? ' ' + recipient.first_name : ''},\n\nYou are now the owner of ${projectName}. Manage it at: ${project_url}/dashboard/sites\n`,
          });
        } catch (err) {
          ctx.logger.warn(`Failed to send transfer email to new owner: ${(err as Error).message}`);
        }
      }

      return res.json({
        success: true,
        new_owner_id: recipient.id,
      });
    } catch (error) {
      return sendError(res, error, { route: 'transfer-ownership', siteId, stage });
    }
  });
};

export default endpoint;
