# pi-codex-manager

Single-command pi extension for OpenAI Codex account profiles and request `service_tier`.

It intentionally registers only one slash command: `/codex`.

## Install

```bash
pi install /absolute/path/to/pi-codex-manager
```

If pi is already running:

```text
/reload
```

Disable/uninstall older separate extensions (`pi-codex-switch`, `pi-codex-fast`, `pi-codex-service-tier`) to avoid duplicate status lines or request hooks.

## Commands

```text
/codex status
/codex help

/codex profile save a
/codex profile switch a
/codex profile list
/codex profile current

/codex tier priority
/codex tier flex
/codex tier default
/codex tier auto
/codex tier scale
/codex tier off
/codex tier status
```

## Setup profiles

Login and save account A:

```text
/login openai-codex
/codex profile save a
```

Login and save account B:

```text
/login openai-codex
/codex profile save b
```

Switch later:

```text
/codex profile switch a
/codex profile switch b
```

If you use `auto` / `websocket-cached` transport and want a clean cached WebSocket/context after switching:

```text
/codex profile switch b
/new
```

## Storage

Profiles are stored in:

```text
~/.pi/agent/codex-profiles/
```

Service tier state is stored in global pi settings:

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

For migration, the extension reads the old `pi-codex-fast` setting as a fallback and removes it the next time `/codex tier ...` writes state.

## Notes

- Only the `openai-codex` auth entry is changed when switching profiles; other `auth.json` credentials are kept.
- OAuth tokens are sensitive. Do not commit `~/.pi/agent/auth.json` or `~/.pi/agent/codex-profiles/`.
- The profile switcher uses pi internal auth access: `ctx.modelRegistry.authStorage`, so future pi updates could require changes.
