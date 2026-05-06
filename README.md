# pi-codex-manager

Manage OpenAI Codex accounts and service tier from one pi command: `/codex`.

This extension replaces separate Codex helpers such as account switching and fast/service-tier toggling. It intentionally keeps the command space small by registering only `/codex`.

## Demo

<video src="./codex_manager_0.1.mp4" controls width="100%"></video>

If the video does not render in your viewer, open [`codex_manager_0.1.mp4`](./codex_manager_0.1.mp4) directly.

## Install from GitHub

```bash
pi install git:github.com/Tulip4attoo/pi-codex-manager
```

Restart pi, or reload if pi is already running:

```text
/reload
```

Check that it is available:

```text
/codex status
```

### Recommended: disable older Codex extensions

If you previously installed separate extensions, remove or disable them to avoid duplicate commands, status lines, or request hooks:

- `pi-codex-switch`
- `pi-codex-fast`
- `pi-codex-service-tier`

For local symlink installs, this is usually:

```bash
rm ~/.pi/agent/extensions/codex-fast.ts ~/.pi/agent/extensions/codex-switch.ts
```

Then reload pi:

```text
/reload
```

## Usage

Show current Codex manager state:

```text
/codex status
```

Show all commands:

```text
/codex help
```

## Account profiles

Profiles let you save multiple `openai-codex` OAuth logins and switch between them without restarting pi.

Login and save account 1:

```text
/login openai-codex
/codex profile save 1
```

Login and save account 2:

```text
/login openai-codex
/codex profile save 2
```

Switch accounts later:

```text
/codex profile switch 1
/codex profile switch 2
```

List saved profiles:

```text
/codex profile list
```

Show the current profile/account:

```text
/codex profile current
```

Profile names can contain letters, numbers, dots, underscores, and dashes, so names like `1`, `work`, `plus-a`, and `team.main` are valid.

## Service tier

Set the OpenAI/OpenAI Codex `service_tier` sent with requests:

```text
/codex tier priority
/codex tier flex
/codex tier default
/codex tier auto
/codex tier scale
/codex tier off
/codex tier status
```

Common options:

- `priority` - fast mode
- `flex` - slower/cheaper where supported
- `off` - do not inject `service_tier`; use provider/project default

The tier is only injected for providers `openai` and `openai-codex`, and only when the request payload does not already contain `service_tier`.

## Autocomplete

Saved profiles are used for `/codex` completions. For example, after saving:

```text
/codex profile save 1
/codex profile save 2
/codex profile save 3
```

Typing this will suggest the saved profiles:

```text
/codex profile switch 
```

## Storage and scope

Profiles are stored globally for your user:

```text
~/.pi/agent/codex-profiles/
```

The active profile marker is also global:

```text
~/.pi/agent/codex-profiles/active
```

Service tier state is stored in global pi settings:

```text
~/.pi/agent/settings.json
```

under:

```json
{
  "codex-manager": {
    "tier": {
      "enabled": true,
      "value": "priority"
    }
  }
}
```

Project settings can override global settings through:

```text
<project>/.pi/settings.json
```

## Notes

- Only the `openai-codex` auth entry is changed when switching profiles; other `auth.json` credentials are kept.
- If you use `auto` / `websocket-cached` transport, run `/new` after switching profiles when you want a fresh cached WebSocket/context.
- OAuth tokens are sensitive. Do not commit `~/.pi/agent/auth.json` or `~/.pi/agent/codex-profiles/`.
- The profile switcher uses pi internal auth access: `ctx.modelRegistry.authStorage`, so future pi updates could require changes.
