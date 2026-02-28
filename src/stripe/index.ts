import type { EndpointConfig } from '@directus/extensions';
import type { MailService, SettingsService, UsersService } from '@directus/api/services/index';
import { isDirectusError, InvalidPayloadError, UnexpectedResponseError, ForbiddenError } from '@directus/errors';

import StripeService from 'stripe';
import { generateLicenseKey } from '../lib/license.js';

const sleep = (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const endpoint: EndpointConfig = async (router, ctx) => {
  const stripeKey = ctx.env['STRIPE_SECRET_KEY'];
  const stripeWhSecret = ctx.env['STRIPE_WEBHOOK_SECRET'];

  if (!stripeKey) {
    console.warn('Missing STRIPE_SECRET_KEY env variable. Stripe endpoints disabled.');
    return;
  }

  console.log(`STRIPE_WEBHOOK_SECRET ${stripeWhSecret ? 'enabled' : 'missing'}.`);

  const schema = await ctx.getSchema();
  const settings = new (ctx.services.SettingsService as typeof SettingsService)({ schema });
  const users = new (ctx.services.UsersService as typeof UsersService)({ schema });
  const stripe = new StripeService(stripeKey);

  router.post('/create-checkout-session', async (req, res) => {
    try {
      const userId = (req as any).accountability?.user;
      if (!userId) {
        throw new ForbiddenError(undefined, { cause: 'You are not logged in.' });
      }

      const user = await users.readOne(userId);
      if (!user) {
        throw new ForbiddenError(undefined, { cause: 'User does not exist.' });
      }

      if (!req.body['price_key']) {
        throw new InvalidPayloadError({ reason: 'Missing price_key from payload.' });
      }

      const {
        data: [price],
      } = await stripe.prices.list({
        lookup_keys: [req.body['price_key']],
        expand: ['data.product'],
      });

      if (!price) {
        throw new InvalidPayloadError({ reason: `Item "${req.body['price_key']}" does not exist.` });
      }

      const { project_url } = await settings.readSingleton({});

      const sessionCreateParams: StripeService.Checkout.SessionCreateParams = {
        billing_address_collection: 'auto',
        line_items: [
          {
            price: price.id,
            quantity: 1,
          },
        ],
        mode: price?.type === 'one_time' ? 'payment' : 'subscription',
        success_url: `${project_url}/dashboard/sites?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${project_url}/dashboard/billing`,
        metadata: { directus_user_id: user['id'] },
      };

      if (user['stripe_customer_id']) {
        sessionCreateParams.customer = user['stripe_customer_id'];
      } else {
        sessionCreateParams.customer_email = user['email'];
        if (price?.type === 'one_time') {
          sessionCreateParams.customer_creation = 'always';
        }
      }

      if (price?.type === 'one_time') {
        sessionCreateParams.invoice_creation = { enabled: true };

        // TODO: Probably not needed...
        //   sessionCreateParams.payment_intent_data = {
        //     setup_future_usage: 'off_session',
        //   };
      }

      const session = await stripe.checkout.sessions.create(sessionCreateParams);

      if (!session.url) {
        throw new UnexpectedResponseError(undefined, { cause: 'Could not create stripe checkout session.' });
      }

      return res.json({ redirect_url: session.url });
    } catch (error) {
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: {
            ...error,
            message: error.message,
            cause: error.cause,
          },
        });
      } else {
        return res.status(500).json({
          error,
        });
      }
    }
  });

  router.post('/create-portal-session', async (req, res) => {
    try {
      const userId = (req as any).accountability?.user;
      if (!userId) {
        throw new ForbiddenError(undefined, { cause: 'You are not logged in.' });
      }

      const user = await users.readOne(userId);

      if (!user) {
        throw new ForbiddenError(undefined, { cause: 'User does not exist.' });
      }

      if (!user['stripe_customer_id']) {
        throw new InvalidPayloadError({ reason: 'User is not a stripe customer.' });
      }

      const { project_url } = await settings.readSingleton({});

      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user['stripe_customer_id'],
        return_url: `${project_url}/dashboard/profile`,
      });

      return res.json({ redirect_url: portalSession.url });
    } catch (error) {
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: {
            ...error,
            message: error.message,
            cause: error.cause,
          },
        });
      } else {
        return res.status(500).json({
          error,
        });
      }
    }
  });

  const waitForCustomerCreation = async (customerId: string) => {
    if (!customerId) {
      throw new InvalidPayloadError({ reason: 'No customer ID provided' });
    }
    for (let i = 1; i < 10; i++) {
      const [customerUser] = await users.readByQuery({
        filter: {
          stripe_customer_id: {
            _eq: customerId,
          },
        },
      });
      if (customerUser) {
        return customerUser;
      }
      await sleep(i * 1000);
    }
    throw new InvalidPayloadError({ reason: 'Customer not found in users table.' });
  };

  // To test these:
  // stripe listen --events customer.created,checkout.session.completed,customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,customer.subscription.trial_will_end --forward-to http://localhost:8055/stripe/webhook
  router.post('/webhook', async (req, res) => {
    try {
      console.log('req.body', req.body);
      let event = req.body;

      if (stripeWhSecret) {
        // Get the signature sent by Stripe
        const signature = String(req.headers['stripe-signature']);
        try {
          event = stripe.webhooks.constructEvent(event, signature, stripeWhSecret);
        } catch (err) {
          console.log(`⚠️  Webhook signature verification failed.`, (err as any).message);
          return res.sendStatus(400);
        }
      }

      console.log(`Received stripe event: ${event.type}`);

      // Handle the event
      switch (event.type) {
        case 'customer.created':
          const customer = event.data.object;
          if (!customer.email) {
            throw new InvalidPayloadError({ reason: 'No customer email provided' });
          }
          const [newPaidUser] = await users.readByQuery({
            filter: {
              email: {
                _icontains: customer.email,
              },
            },
          });
          if (!newPaidUser) {
            throw new InvalidPayloadError({ reason: 'User not found.' });
          }
          const newCustomerUserData = {
            stripe_customer_id: customer.id,
          };
          await users.updateOne(newPaidUser['id'], newCustomerUserData);
          console.log(`Update user ${newPaidUser['id']}:`, newCustomerUserData);

          break;

        case 'checkout.session.completed':
          const session = event.data.object;
          const checkedOutUser = await waitForCustomerCreation(session.customer);
          const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price'] });
          const price = lineItems?.data?.[0]?.price;
          if (!price) {
            throw new InvalidPayloadError({ reason: `Price not found for session ${session.id}` });
          }
          const checkoutUserData = {
            stripe_price_id: price.id,
            stripe_price_key: price.lookup_key,
            stripe_subscription_status: 'active',
          };
          await users.updateOne(checkedOutUser['id'], checkoutUserData);
          console.log(`Update user ${checkedOutUser['id']}:`, checkoutUserData);

          if (price.lookup_key === 'lifetime') {
            const mail = new (ctx.services.MailService as typeof MailService)({ schema });

            await mail.send({
              to: checkedOutUser['email']!,
              subject: `Your DecapBridge self-hosting key:`,
              template: {
                name: 'license-key',
                data: {
                  key: generateLicenseKey(checkedOutUser['id'], ctx.env['SECRET']),
                },
              },
            });

          }

          break;

        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
        case 'customer.subscription.trial_will_end':
          const subscription = event.data.object;
          const subPrice = subscription.items.data[0].price;
          const updatedUser = await waitForCustomerCreation(subscription.customer);
          const subscriptionUserData = {
            stripe_price_id: subPrice.id,
            stripe_price_key: subPrice.lookup_key,
            stripe_subscription_status: subscription.status,
          };
          await users.updateOne(updatedUser['id'], subscriptionUserData);
          break;

        default:
          // Unexpected event type
          return res.send('Event not handled.');
      }
      // Return a 200 response to acknowledge receipt of the event
      return res.send('OK');
    } catch (error) {
      console.info(`/stripe/webhook error: ${error}`);
      if (isDirectusError(error)) {
        return res.status(error.status).json({
          error: {
            ...error,
            message: error.message,
            cause: error.cause,
          },
        });
      } else {
        return res.status(500).json({
          error,
        });
      }
    }
  });
};

export default endpoint;
