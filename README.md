# Herdr Auto Session Title

Automatically generate a concise title from the first user request in a Herdr
agent session. The plugin updates Herdr's pane metadata and, when the detected
agent is Codex, also synchronizes the native Codex thread name through
`thread/name/set`.

## Behavior

The plugin runs after `pane.agent_detected`, useful
`pane.agent_status_changed`, and `pane.focused` events. It:

1. Waits briefly for Herdr's session identity when a Codex process is first
   detected.
2. For a resumed or switched Codex session, adopts its existing native thread
   name. Otherwise, reads the first usable user message from the local session
   JSONL and runs an isolated, ephemeral `codex exec` turn to generate a title
   of at most 36 characters.
3. Reports the resolved title to Herdr as both the pane title and displayed
   agent name, then renames the containing tab.
4. For Codex panes, reads the native thread through `codex app-server` and sets
   an empty or plugin-owned name with `thread/name/set`.
5. When Codex exits, clears the plugin-owned pane title and displayed agent
   name, then restores the tab's numeric label if the tab is still named by this
   plugin.

The first request determines a newly generated automatic title. Follow-up
messages do not continually rename the session. Resuming or switching to a
thread that already has a native Codex name adopts that name instead. Use the
refresh action when you explicitly want to regenerate the current title.

| Agent | Herdr pane title | Herdr displayed agent name | Native agent title |
| --- | --- | --- | --- |
| Codex | Yes | Yes | Yes, via `thread/name/set` |
| Claude Code | Yes | Yes | No |
| Other agents | Ignored | No | No |

Manual titles win, subject to the non-atomic tab rename limitation documented
under Privacy and safety. The plugin only replaces a Herdr pane title, tab
label, or Codex title when it is empty, still has its numeric default, or still
equals the last title written by this plugin. The displayed agent name follows
the plugin's generated title and is cleared when the agent session exits. If a
Codex thread already has a
native title, that title is adopted as the Herdr title so the surfaces remain
synchronized without claiming ownership of the native title. On Codex exit,
cleanup uses the same ownership check and preserves a manual tab label it
observes. If a delayed exit event arrives after another session is already
active, cleanup finishes first and the new session is synchronized immediately.

## Requirements

- Herdr 0.7.0 or newer
- Node.js 20 or newer
- Codex CLI available on `PATH` and authenticated

The Codex CLI is used for title generation for both supported agents. Native
Codex synchronization additionally requires a Codex version that provides the
`thread/read` and `thread/name/set` app-server methods. The protocol integration
is tested with Codex CLI 0.146.0. If generation or native synchronization fails,
the plugin still applies a local truncated-title fallback to Herdr and retries
Codex synchronization on a later event.

## Install

```sh
herdr plugin install yobiscus/herdr-auto-session-title
```

For local development:

```sh
git clone https://github.com/zhangzujian/herdr-auto-session-title.git
cd herdr-auto-session-title
herdr plugin link .
```

No configuration file is required. Herdr supplies its own executable path and
plugin state directory; title generation uses the authenticated Codex CLI's
default model.

## Configuration

The optional `config.json` file lives in the directory printed by:

```sh
herdr plugin config-dir yobiscus.auto-session-title
```

Set `rename_tab` to `false` to keep automatic titles out of Herdr's tab labels.
Pane titles and the displayed sidebar agent name continue to update. The
default is `true`.

```json
{
  "rename_tab": false
}
```

The plugin reads this file on each event, so changes apply without restarting
Herdr.

## Manual refresh

Invoke the action while targeting a pane:

```sh
herdr plugin action invoke yobiscus.auto-session-title.refresh
```

The action is also available through Herdr's plugin action UI.

## Privacy and safety

- The plugin reads local Codex (`$CODEX_HOME/sessions`) or Claude Code
  (`~/.claude/projects`) session JSONL files.
- Up to the first 2,000 characters of the first user request are sent to the
  provider used by `codex exec` for title generation.
- Generation uses `--ephemeral`, ignores user configuration and rules, runs in
  a read-only sandbox, and does not persist a new Codex session.
- `HERDR_*` environment variables are removed from Codex subprocesses to avoid
  recursive integration behavior and leaking Herdr invocation context.
- Plugin state stores titles, a prompt hash, and session identifiers under
  `HERDR_PLUGIN_STATE_DIR`; it does not store prompt text.
- Per-pane locks suppress duplicate concurrent generation. Ownership checks
  protect manual Herdr and native Codex titles after they diverge from the
  plugin-owned value, subject to the tab rename limitation below. Partial exit
  cleanup is retried on a later pane focus or agent lifecycle event.

Herdr 0.7.5 does not expose an atomic conditional tab rename. The plugin checks
the current tab label immediately before renaming it, but a manual rename that
lands between that check and the rename command can still be overwritten. Pane
metadata and native Codex title updates retain their ownership checks.

## Development

There are no runtime npm dependencies.

```sh
npm test
```

## License

MIT
