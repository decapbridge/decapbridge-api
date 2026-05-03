import type { HookConfig, HookExtensionContext } from '@directus/extensions';
import type { RolesService, UsersService, FilesService } from '@directus/api/services/index';
import type { User } from '@directus/types';

const SSO_AVATAR_TIMEOUT_MS = 3000;

type SsoFilterMeta = {
  provider?: string;
  identifier?: string;
  providerPayload?: { userInfo?: { picture?: string } };
};

const extractGooglePicture = (meta: unknown): { identifier: string; picture: string } | null => {
  const m = meta as SsoFilterMeta;
  if (m.provider !== 'google' || !m.identifier) return null;
  const picture = m.providerPayload?.userInfo?.picture;
  if (!picture) return null;
  return { identifier: m.identifier, picture };
};

// Google profile URLs end in `=s96-c`; bump to s256 for crisper rendering.
const upsizeGooglePictureUrl = (url: string): string => url.replace(/=s\d+-c$/, '=s256-c');

const importSsoAvatar = async (
  pictureUrl: string,
  identifier: string,
  uploadedBy: string | null,
  ctx: HookExtensionContext,
): Promise<string | null> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    const schema = await ctx.getSchema();
    const filesService = new (ctx.services.FilesService as typeof FilesService)({ schema });
    const safeId = identifier.replace(/[^a-zA-Z0-9.@_-]+/g, '_');
    const body = {
      filename_download: `sso-avatar-${safeId}.jpg`,
      title: `SSO avatar (${identifier})`,
      ...(uploadedBy && { uploaded_by: uploadedBy }),
    };
    const fileId = await Promise.race([
      filesService.importOne(upsizeGooglePictureUrl(pictureUrl), body),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('SSO avatar import timeout')), SSO_AVATAR_TIMEOUT_MS);
      }),
    ]);
    return String(fileId);
  } catch (err) {
    ctx.logger.warn(`[user-signup] SSO avatar import failed: ${(err as Error).message}`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const hook: HookConfig = async ({ filter, action }, ctx) => {
  const schema = await ctx.getSchema();
  const roles = new (ctx.services.RolesService as typeof RolesService)({ schema });
  const users = new (ctx.services.UsersService as typeof UsersService)({ schema });

  const [userRole] = await roles.readByQuery({
    filter: {
      name: {
        _eq: 'User',
      },
    },
    fields: ['id'],
  });
  const adminEmail = ctx.env['ADMIN_EMAIL'];
  const userRoleId = userRole?.['id'];
  if (userRoleId) {
    filter('users.create', (payload: any) => {
      if (payload.email !== adminEmail) {
        return {
          ...payload,
          role: userRoleId,
          // Allow SSO for all users based on their email
          external_identifier: payload.email,
        };
      }
      return payload;
    });
  }

  action('auth.login', async (meta) => {
    if (meta['status'] === 'success' && meta['user'] && meta['provider']) {
      await users.updateOne(meta['user'], {
        provider: meta['provider'],
      });
    }
  });

  filter<Pick<User, 'email' | 'first_name' | 'last_name' | 'provider' | 'avatar'> | undefined>(
    'auth.update',
    async (payload, meta) => {
      if (!payload?.email) {
        console.error('Missing email auth payload.');
        return;
      }

      const [user] = await users.readByQuery({
        filter: {
          email: {
            _eq: payload.email,
          },
        },
        fields: ['id', 'email', 'first_name', 'last_name', 'avatar'],
      });
      if (!user) {
        console.error('User not found in "auth.update" filter.');
        return;
      }

      // Only update these values if the user doesn't have anything already set.
      // If the user already hase these details, keep the existing ones.
      if (user['first_name']) {
        payload.first_name = user['first_name'];
      }
      if (user['last_name']) {
        payload.last_name = user['last_name'];
      }

      const sso = extractGooglePicture(meta);
      if (sso && !user['avatar']) {
        const fileId = await importSsoAvatar(sso.picture, sso.identifier, user['id'] as string, ctx);
        if (fileId) {
          payload.avatar = fileId as unknown as User['avatar'];
        }
      }

      return payload;
    }
  );

  filter<Partial<User>>('auth.create', async (payload, meta) => {
    const sso = extractGooglePicture(meta);
    if (sso) {
      const fileId = await importSsoAvatar(sso.picture, sso.identifier, null, ctx);
      if (fileId) {
        payload.avatar = fileId as unknown as User['avatar'];
      }
    }
    return payload;
  });
};

export default hook;
