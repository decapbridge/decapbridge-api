import type { HookConfig } from '@directus/extensions';
import type { ItemsService, UsersService } from '@directus/api/services/index';
import { InvalidPayloadError } from '@directus/errors';

const FREE_SITES_LIMIT = 3;

const hook: HookConfig = async ({ filter }, ctx) => {
  filter('sites.items.create', async (payload: any, _meta: any, context: any) => {
    const userId = context.accountability?.user;
    if (!userId) return payload;

    const schema = await ctx.getSchema();
    const users = new (ctx.services.UsersService as typeof UsersService)({ schema });

    const user = await users.readOne(userId, { fields: ['stripe_subscription_status'] });
    if (user['stripe_subscription_status'] === 'active') {
      return payload;
    }

    const sites = new (ctx.services.ItemsService as typeof ItemsService)('sites', { schema });
    const existingSites = await sites.readByQuery({
      filter: {
        user_created: { _eq: userId },
      },
      aggregate: { count: ['id'] },
    });

    const count = Number(existingSites[0]?.['count']?.['id'] ?? 0);
    if (count >= FREE_SITES_LIMIT) {
      throw new InvalidPayloadError({
        reason: `Free accounts are limited to ${FREE_SITES_LIMIT} sites. Please upgrade your plan to add more sites.`,
      });
    }

    return payload;
  });
};

export default hook;
