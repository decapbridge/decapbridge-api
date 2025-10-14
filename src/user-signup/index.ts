import type { HookConfig } from '@directus/extensions';
import type { RolesService, UsersService } from '@directus/api/services/index';
import type { User } from '@directus/types';

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

  filter<Pick<User, 'email' | 'first_name' | 'last_name' | 'provider'> | undefined>(
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
        fields: ['email', 'first_name', 'last_name'],
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

      return payload;
    }
  );
};

export default hook;
