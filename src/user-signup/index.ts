import type { HookConfig } from '@directus/extensions';
import type { RolesService } from '@directus/api/services/index';

const hook: HookConfig = async ({ filter }, ctx) => {
  const schema = await ctx.getSchema();
  const roles = new (ctx.services.RolesService as typeof RolesService)({ schema });

  const [userRole] = await roles.readByQuery({
    filter: {
      name: {
        _eq: 'User',
      },
    },
  });
  const adminEmail = ctx.env['ADMIN_EMAIL'];
  const userRoleId = userRole?.['id'];
  if (userRoleId) {
    filter('users.create', (payload: any) => {
      if (payload.email !== adminEmail) {
        return {
          ...payload,
          role: userRoleId,
        };
      }
      return payload;
    });
  }
};

export default hook;
