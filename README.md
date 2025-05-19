# DecapBridge auth server

This is the auth backend for DecapBridge. It's a node.js + postgres app built using Directus to scaffold it out.

In short, this is where users are stored, along with their sites and the member assignations. Auth functionality (login, signup, forgot password, etc) is handled here. Invitation emails are sent from here as well.

## Requirements

- Docker
- node.js
- postgres
- a mail server

## Installation

```sh
git clone git@github.com:loteoo/directus-starter.git
cd directus-starter
npm install
cp .env.example .env
run config:apply
run directus users passwd --email admin@email.com --password xxxxxx
run help
```

## Development

```sh
run dev
```

This will spin up a local directus server and a typescript compiler with live reloading for the extensions.

You can configure directus by either tweaking things in the UI, or by extending it with extensions in the `src` directory.

#### Extensions

The `src` directory is a "multi-extension" package will get compiled into a single `bundle` extension in directus. To add a new extensions run `run extension add`.

#### Directus config

When modifying the schema and permissions through the UI, remember to save the changes to git:

```sh
npm run config:snapshot
```

#### Upgrade Directus version

```sh
npm update
npm install directus@latest
npm exec directus database migrate:latest
npm run config:snapshot
```

Remember to also update the SDK in the UI via `npm install @directus/sdk@latest`
