import fs from 'fs';
import type { HookConfig } from '@directus/extensions';
import type { Query } from '@directus/types';
import type { ItemsService, ImportService, ExportService } from '@directus/api/services/index';

// Order matters, could have foreign key issues
const queries: Record<string, Query> = {
  directus_roles: {},
  directus_permissions: {},
  directus_users: {
    fields: ['id', 'first_name', 'last_name', 'email', 'role'],
    filter: {
      role: {
        admin_access: {
          _eq: true,
        },
      },
    },
  },
  directus_presets: {},
  directus_settings: {},
};

const tables = Object.keys(queries);

const hook: HookConfig = async ({ init }, ctx) => {
  init('cli.after', async () => {
    const command = process.argv[3];
    const schema = await ctx.getSchema();

    if (command === 'snapshot') {
      ctx.logger.info(`Exporting tables: ${tables.join(', ')}`);

      const schema = await ctx.getSchema();
      const exportService = new (ctx.services.ExportService as typeof ExportService)({ schema });
      for (const table of tables) {
        const items = new (ctx.services.ItemsService as typeof ItemsService)(table, { schema });
        const fields = schema.collections[items.collection]?.fields!;
        const rawFields = Object.entries(fields)
          .filter(([_, overview]) => !overview.alias)
          .map(([field]) => field);
        const data = await items.readByQuery({
          fields: rawFields,
          ...queries[table],
        });
        const csv = exportService.transform(data, 'csv', {
          includeHeader: true,
          includeFooter: true,
        });
        const path = `${process.cwd()}/config/${table}.csv`;
        await fs.writeFileSync(path, csv, { encoding: 'utf8' });
        ctx.logger.info(`==> ${table} exported to ./config/${table}.csv`);
      }
    } else if (command === 'apply') {
      ctx.logger.info(`Importing tables: ${tables.join(', ')}`);
      const importService = new (ctx.services.ImportService as typeof ImportService)({ schema });
      for (const table of tables) {
        const path = `${process.cwd()}/config/${table}.csv`;
        const file = await fs.createReadStream(path, { encoding: 'utf8' });
        await importService.importCSV(table, file);
        ctx.logger.info(`==> ${table} imported.`);
      }
    }
  });
};

export default hook;
