# pi-codex-manager

Manage OpenAI Codex accounts, live usage, and **Fast mode** from one pi command: `/codex`.

Switch easily between multiple Codex accounts without logging out, logging back in, and repeating the OAuth flow every time one account hits quota. Jump between them with `/codex profile switch <name>`, and see remaining 5h/7d quota in the footer and `/codex status`.

This extension replaces separate Codex helpers such as account switching and fast/service-tier toggling. It intentionally keeps the command space small by registering only `/codex`.

## Demo

![pi-codex-manager demo](./media/codex_manager_0.2.0.gif)

## Install from GitHub

```bash
pi install git:github.com/Tulip4attoo/pi-codex-manager
```

## Usage

Enable fast mode:

```text
/codex fast
```

Switch account:

```text
/codex profile switch a
(or whatever you named)
```

### Recommended: disable older Codex extensions

If you previously installed separate extensions, remove or disable them to avoid duplicate commands, status lines, or request hooks, then reload pi.

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

Show live usage for the current/saved profiles:

```text
/codex status
```

The footer also shows remaining quota for the active account, for example:

```text
codex:a (account …73b9672b)  5h ▰▰▰▰▱▱▱▱ 50%  7d ▰▰▰▰▰▰▱▱ 75%
```

Show the current profile/account:

```text
/codex profile current
```

Profile names can contain letters, numbers, dots, underscores, and dashes, so names like `1`, `work`, `plus-a`, and `team.main` are valid.

## Service tier

Set the OpenAI/OpenAI Codex `service_tier` sent with requests:

```text
/codex tier           # toggle priority on/off
/codex fast           # same as /codex tier
/codex tier priority  # fast mode
/codex tier scale
/codex tier off       # do not inject service_tier
```

Options:

- `priority` - fast mode
- `scale` - scale tier where supported
- `off` - do not inject `service_tier`; use provider/project default

`/codex fast` is a convenience form for `/codex tier`, so it toggles priority mode on/off.

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
- OAuth tokens are sensitive. Do not commit `~/.pi/agent/auth.json`, `~/.pi/agent/codex-profiles/`, or `~/.codex/auth.json`.
- Live usage is read from ChatGPT's `https://chatgpt.com/backend-api/wham/usage` endpoint with the active Codex access token; `/codex status` and each completed agent turn refresh it.
- The profile switcher uses pi internal auth access: `ctx.modelRegistry.authStorage`, so future pi updates could require changes.
