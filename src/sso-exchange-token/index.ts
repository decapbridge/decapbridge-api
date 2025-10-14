import type { EndpointConfig } from '@directus/extensions';
import type { SettingsService } from '@directus/api/services/index';
import isDirectusJWT from '@directus/api/utils/is-directus-jwt';
import { isDirectusError, InvalidTokenError } from '@directus/errors';
import { verifyAccessJWT } from '@directus/api/utils/jwt';
import { getSecret } from '@directus/api/utils/get-secret';

const endpoint: EndpointConfig = (router, ctx) => {
  router.get('/', async (req, res) => {
    const schema = await ctx.getSchema();
    const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
    try {
      const { project_url } = await settings.readSingleton({});
      if (req.query['reason']) {
        return res.redirect(`${project_url}/auth/login?error=${req.query['reason']}`);
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

      let loginUrl = `${project_url}/auth/sso-callback?code=${refreshToken}`;
      if (req.query['redirect_uri']) {
        loginUrl = `${loginUrl}&redirect_uri=${req.query['redirect_uri']}`;
      }
      return res.clearCookie(ctx.env['SESSION_COOKIE_NAME']).redirect(loginUrl);
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
