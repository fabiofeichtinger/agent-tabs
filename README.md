# agent-tabs

Let AI agents (any MCP client) and your shell list, group, move, open, focus and
close Chrome tabs and tab groups. Local only: it talks to the browser through
Chrome **native messaging**, with no HTTP server, no WebSocket, no cloud relay
and no DevTools Protocol.

- Tiny Manifest V3 extension with exactly three permissions: `tabs`, `tabGroups`, `nativeMessaging`
- One Node.js CLI (Node 18+, zero runtime dependencies) that is also the MCP server and the native host
- Closing tabs is always a dry run unless explicitly confirmed

```
$ agent-tabs list-tabs
Window 1570867542
1570867543    about:blank  about:blank
1570867544    Example Domain  https://example.com/  [group 7 "Research" blue]
1570867545 *  Example Domain  https://example.org/  [group 7 "Research" blue]
```

## How it works

```
 ┌────────────┐  stdio, JSON-RPC 2.0   ┌──────────────────┐
 │ MCP client │ ─────────────────────► │ agent-tabs mcp    │──┐
 └────────────┘  (newline-delimited)   └──────────────────┘  │  Unix domain socket
 ┌────────────┐                        ┌──────────────────┐  │  $XDG_RUNTIME_DIR/agent-tabs/host-<pid>.sock
 │   shell    │ ─────────────────────► │ agent-tabs <cmd>  │──┤  (dir 0700, socket 0600)
 └────────────┘                        └──────────────────┘  │
                                                             ▼
                                        ┌──────────────────────────────┐
                                        │ native host (agent-tabs host) │  started by Chrome,
                                        │                              │  lives as long as the port
                                        └──────────────────────────────┘
                                                     ▲  stdin/stdout, 4-byte length-prefixed JSON
                                                     ▼  (Chrome native messaging)
                                        ┌──────────────────────────────┐
                                        │ MV3 service worker           │ ─► chrome.tabs
                                        │ (extension/background.js)    │ ─► chrome.tabGroups
                                        └──────────────────────────────┘ ─► chrome.windows
```

1. When the browser starts (or the extension is installed) the service worker calls
   `chrome.runtime.connectNative("com.agenttabs.host")`. Chrome looks up the host
   manifest, checks that the extension's origin is in `allowed_origins`, and starts
   the launcher script.
2. The host opens a Unix socket and relays requests between socket clients and the
   extension, correlating them by id, with timeouts.
3. The open port keeps the service worker alive. If the port drops, the extension
   reconnects with exponential backoff (1 s up to 60 s). When Chrome exits, the host
   sees EOF on stdin, removes its socket and exits.
4. Each browser profile that runs the extension gets its own host and socket; the
   CLI uses the most recently started one unless `--socket` is given.

## Install (from source)

Requirements: Node.js 18+, a Chromium-based browser (Chrome, Chromium, Brave, Edge),
macOS or Linux.

```sh
git clone <repo-url> agent-tabs
cd agent-tabs
./install.sh                 # writes the native host manifest + launcher (same as `node bin/agent-tabs.js install`)
npm link                     # optional: puts `agent-tabs` on your PATH (or use: node bin/agent-tabs.js ...)
```

Then load the extension:

1. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select the `extension/` directory.
4. The extension ID must be `fafpncbnpnoipmnfnpcpaopookpogfii` (fixed by the `key` in
   `extension/manifest.json`).
5. Check: `agent-tabs status`.

`agent-tabs install` writes `com.agenttabs.host.json` into the `NativeMessagingHosts`
directory of every supported browser whose config directory exists:

| Browser | macOS (`~/Library/Application Support/…`) | Linux (`~/.config/…`) |
|---|---|---|
| Chrome / Beta / Dev / Canary | `Google/Chrome[ Beta│ Dev│ Canary]` | `google-chrome[-beta│-unstable│-canary]` |
| Chrome for Testing | `Google/Chrome for Testing` | `google-chrome-for-testing` |
| Chromium | `Chromium` | `chromium` |
| Arc | `Arc/User Data` | n/a |
| Vivaldi | `Vivaldi` | `vivaldi` |
| Brave | `BraveSoftware/Brave-Browser` | `BraveSoftware/Brave-Browser` |
| Edge / Beta / Dev | `Microsoft Edge[ Beta│ Dev]` | `microsoft-edge[-beta│-dev]` |

The manifest's `path` points to a small launcher (`~/.agent-tabs/agent-tabs-host`)
that hardcodes the absolute path of the `node` binary used at install time, because
Chrome starts native hosts without your shell's `PATH`. Re-run `agent-tabs install`
if you move the checkout or switch Node versions.

Options:

```sh
agent-tabs install --browser brave --browser chromium     # force specific browsers (creates dirs)
agent-tabs install --extension-id <id> [--extension-id <id2>]   # e.g. a Web Store build
agent-tabs install --target-dir /path/to/profile/NativeMessagingHosts
agent-tabs install --dry-run
agent-tabs uninstall [--target-dir DIR]
```

**Custom `--user-data-dir` on Linux:** Chrome then reads per-user host manifests from
`<user-data-dir>/NativeMessagingHosts`, *not* from `~/.config/<browser>/…`
(verified with Chrome for Testing 157: `~/.config/google-chrome-for-testing`,
`~/.config/chromium` and `~/.config/google-chrome` were all ignored, while
`<user-data-dir>/NativeMessagingHosts` and the system directory
`/etc/opt/chrome_for_testing/native-messaging-hosts` worked). Use
`--target-dir <user-data-dir>/NativeMessagingHosts` in that case.

## Usage

Every tab command accepts `--json` for machine-readable output, `--socket PATH` to
pick a specific browser, and `--timeout MS`. Underscore names (`list_tabs`) work too, as do the
short aliases `list`, `groups`, `open`, `group`, `move`, `focus`, `close`.

```sh
agent-tabs list-tabs                      # all windows; * = active, P = pinned
agent-tabs list-tabs --window 1570867542 --json
agent-tabs list-groups

agent-tabs open-url https://example.com
agent-tabs open-url https://example.org --background --group 7
agent-tabs open-url about:blank --window 1570867542
agent-tabs open https://a.example https://b.example --title Research --color purple   # several URLs into a new group

agent-tabs group-tabs 101 102 --title Research --color blue     # new group
agent-tabs group-tabs 103 --group 7                             # add to existing group
agent-tabs update-group 7 --title Reading --color green --collapse
agent-tabs update-group 7 --expand
agent-tabs rename 7 Reading list                                # shortcut for update-group --title
agent-tabs ungroup 101 102

agent-tabs move-tabs 103 --index 0
agent-tabs move-tabs 103 104 --end --window 1570867600
agent-tabs focus-tab 103                  # activates the tab and focuses its window

agent-tabs close-tabs 101 102             # dry run: prints what WOULD close, closes nothing
agent-tabs close-tabs 101 102 --confirm   # actually closes (--yes / -y also work)
agent-tabs close --group 7 --confirm      # close every tab in a group

agent-tabs status                         # connected? which browser? ping
agent-tabs doctor                         # checks node, launcher, manifests, socket, connection
agent-tabs mcp                            # MCP server on stdio
```

Colors: `grey blue red yellow green pink purple cyan orange`.
`open-url` accepts only `http:`, `https:` and `about:blank`; everything else
(`javascript:`, `file:`, `data:`, `chrome:` …) is rejected, in the CLI/MCP layer and
again in the extension.

Exit codes: `0` ok, `1` operation failed, `2` usage error, `3` extension not connected.

## MCP setup

The MCP server exposes `list_tabs`, `list_groups`, `group_tabs`, `update_group`,
`ungroup`, `move_tabs`, `open_url`, `focus_tab` and `close_tabs`, with JSON Schemas.
`close_tabs` returns a preview unless called with `confirm: true`; errors come back
as `isError` tool results.

Use absolute paths: desktop apps usually do not inherit your shell `PATH`.

**Claude Code**

```sh
claude mcp add agent-tabs -- agent-tabs mcp
# or, without npm link:
claude mcp add agent-tabs -- /usr/local/bin/node /path/to/agent-tabs/bin/agent-tabs.js mcp
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "agent-tabs": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/agent-tabs/bin/agent-tabs.js", "mcp"]
    }
  }
}
```

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "agent-tabs": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/agent-tabs/bin/agent-tabs.js", "mcp"]
    }
  }
}
```

## Security model

- **Local only.** No network listener of any kind. The only transports are Chrome's
  native messaging pipes and a Unix domain socket.
- **Socket permissions.** The socket lives in `$XDG_RUNTIME_DIR/agent-tabs` (or
  `~/.agent-tabs/run`); the directory is created `0700` and refused if owned by another
  user, the socket is `0600`. It exists only while the browser is connected and is
  removed on exit; sockets left by crashed hosts are detected and deleted.
- **Chrome's origin check.** Chrome only starts the host for extensions listed in the
  manifest's `allowed_origins` (by default only `chrome-extension://fafpncbnpnoipmnfnpcpaopookpogfii/`).
  Web pages cannot reach it.
- **Minimal permissions.** `tabs`, `tabGroups`, `nativeMessaging`. No host permissions,
  no content scripts, no `scripting`, no `debugger`. The extension can see tab titles
  and URLs but **cannot read or modify page content**.
- **Close confirmation.** `close_tabs` is a dry run unless `--confirm` (or `--yes`) / `confirm: true`; the MCP tool description tells the agent to show the preview and get the user's explicit approval first.
  This is enforced inside the extension too, so every socket client gets the same rule.
- **URL allowlist** for `open_url`: http(s) and `about:blank` only.

Threat notes, honestly stated:

- **Any process running as your user can use the socket** (as it can read your browser
  profile anyway). agent-tabs does not defend against local malware running as you.
  It does not add a cross-user or remote attack surface.
- Tab titles and URLs are sent to whatever MCP client you connect, and from there
  possibly to a model provider. Do not connect untrusted MCP clients.
- A malicious or confused agent can open URLs, reorder and group tabs, and (with
  confirmation) close tabs. It cannot read page content, cookies or history.
- The unpacked extension ID is derived from a public key committed in the repo. The
  matching private key is not part of the repo; it only matters for packing a `.crx`.
  A Chrome Web Store build gets a different ID (see [docs/web-store.md](docs/web-store.md)).

## Troubleshooting

Start with `agent-tabs doctor`.

| Symptom | Fix |
|---|---|
| `Chrome extension not connected` | Is the browser running with the extension loaded? Run `agent-tabs install`, then reload the extension in `chrome://extensions` (or restart the browser). |
| Extension's service worker console shows `Specified native messaging host not found` | The manifest is not where this browser looks. Check `agent-tabs doctor`; use `--browser NAME`, or `--target-dir <user-data-dir>/NativeMessagingHosts` for custom profiles. |
| `Access to the specified native messaging host is forbidden` | The extension ID is not in `allowed_origins`. Re-run `agent-tabs install --extension-id <the ID shown in chrome://extensions>`. |
| `Native host has exited` | The launcher failed: usually the Node path baked into `~/.agent-tabs/agent-tabs-host` no longer exists. Re-run `agent-tabs install`. Chrome logs host stderr when started with `--enable-logging=stderr`. |
| Several browsers/profiles connected | The CLI uses the most recent one. Pick another with `--socket $XDG_RUNTIME_DIR/agent-tabs/host-<pid>.sock` (see `ls` of that dir) or `AGENT_TABS_SOCKET`. |
| Branded Chrome ignores `--load-extension` | Expected for Chrome 137+. Load unpacked via `chrome://extensions`, or use Chromium / Chrome for Testing for automation. |

Environment variables: `AGENT_TABS_SOCKET` (socket to use), `AGENT_TABS_RUN_DIR`
(socket directory), `AGENT_TABS_HOME` (launcher location, default `~/.agent-tabs`).

## Development

```sh
npm install          # dev dependency only: the official MCP SDK client used by the e2e test
npm test             # unit tests (node:test): framing, validation, host relay, MCP, installer
CHROME_BIN=/path/to/chromium npm run e2e    # real browser end-to-end test
```

The e2e test needs Chromium or Chrome for Testing
(`npx @puppeteer/browsers install chrome@stable`), because branded Chrome ignores
`--load-extension`. On Linux it runs the browser under `xvfb-run` when available, in a
throwaway profile, and exercises every CLI command plus an MCP session.

Layout:

```
bin/agent-tabs.js      CLI entry point
src/cli.js            commands, argument parsing, output
src/mcp.js            MCP server (hand-written JSON-RPC over stdio)
src/host.js           native messaging host + Unix socket server
src/client.js         socket client used by CLI and MCP
src/framing.js        native (length-prefixed) and newline JSON framing
src/ops.js            operation table: schemas, validation, URL policy
src/install.js        native host manifest installer
src/paths.js          socket / launcher locations
extension/            MV3 extension (manifest.json, background.js)
scripts/e2e.mjs       real-browser end-to-end test
```

## Prior art

agent-tabs was inspired by, but shares no code with:

- [yoke](https://github.com/hamzahamidi/yoke) (MIT)
- [Tabduct](https://github.com/ultrathinker/tabduct) (MIT)

## License

MIT, see [LICENSE](LICENSE).
