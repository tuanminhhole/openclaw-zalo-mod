# Publishing Guide

## Goal

Publish this plugin so users with an existing OpenClaw installation can install it directly from ClawHub or npm.

## Recommended Release Flow

1. Create a dedicated GitHub repository for the plugin.
2. Push the plugin files from this directory into that repository.
3. Tag a release such as `v1.0.0`.
4. Publish the package to npm.
5. Publish the package to ClawHub.

## Required Metadata

Make sure these files stay in sync:

- `package.json`
- `openclaw.plugin.json`
- `README.md`
- `LICENSE`

For ClawHub plugin publishing, `package.json` should include:

- `openclaw.extensions`
- `openclaw.compat.pluginApi`
- `openclaw.compat.minGatewayVersion`
- `openclaw.build.openclawVersion`
- `openclaw.build.pluginSdkVersion`

## Local Validation

```bash
npm pack --dry-run
node --check index.js
```

## Publish to npm

```bash
npm login
npm publish --access public
```

## Publish to ClawHub

```bash
npm i -g clawhub
clawhub package publish . --dry-run
clawhub package publish .
```

## Install Commands for End Users

From ClawHub:

```bash
openclaw plugins install clawhub:openclaw-zalo-mod
```

From npm:

```bash
openclaw plugins install openclaw-zalo-mod
```

## After Installation

Enable the plugin in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "zalo-mod": {
        "enabled": true,
        "config": {
          "groupName": "My Group",
          "botName": "MyBot",
          "zaloDisplayNames": ["Bot Display Name"],
          "adminIds": ["123456789"]
        }
      }
    }
  }
}
```
