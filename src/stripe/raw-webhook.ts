import { defineHook } from '@directus/extensions-sdk';
import express from 'express';

export default defineHook(({ init }) => {
  init('app.before', ({ app }: any) => {
    app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
  });
});
