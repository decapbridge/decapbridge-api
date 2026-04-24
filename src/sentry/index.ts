import type { HookConfig } from '@directus/extensions';
import type * as SentryNode from '@sentry/node';
import { createRequire } from 'node:module';

const Sentry: typeof SentryNode = createRequire(import.meta.url)('@sentry/node');

const hook: HookConfig = ({ init }, ctx) => {
  if (!ctx.env['SENTRY_DSN']) return;

  Sentry.init({
    dsn: ctx.env['SENTRY_DSN'],
    release: ctx.env['SOURCE_COMMIT'],
    tracesSampleRate: 0,
    maxRequestBodySize: 'none',
  });

  init('routes.custom.after', ({ app }) => {
    Sentry.setupExpressErrorHandler(app);
  });
};

export default hook;
