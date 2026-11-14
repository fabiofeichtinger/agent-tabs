# Publishing to the Chrome Web Store (future notes)

The repo currently targets "load unpacked" installs. These are the steps for a
store release later.

## Extension ID

- The `key` in `extension/manifest.json` pins the unpacked ID to
  `fafpncbnpnoipmnfnpcpaopookpogfii`. The private key for it is **not** in the repo.
- A Web Store item gets its own ID, assigned by the store. Remove `key` from the
  manifest in the uploaded package (the store rejects or ignores it) and note the new ID.
- Add the store ID to `allowed_origins` next to the dev ID:
  - code: add it to the default list in `src/constants.js` / `src/install.js`
  - users today: `grok-tabs install --extension-id fafpncbnpnoipmnfnpcpaopookpogfii --extension-id <store-id>`
- `grok-tabs doctor` should then accept either ID.

## Permission justifications (for the store listing)

| Permission | Justification |
|---|---|
| `tabs` | Read tab titles and URLs so the local CLI / AI agent can list and find tabs; create, move, activate and close tabs on request. |
| `tabGroups` | List, create, rename, recolor, collapse and expand tab groups on request. |
| `nativeMessaging` | The only channel to the locally installed grok-tabs helper. No network communication. |

No host permissions, no content scripts, no remote code. Single purpose: "manage
tabs and tab groups from a local command-line tool or AI agent".

## Privacy policy

Required because the extension handles browsing data (titles, URLs). Content:

- Data accessed: tab titles, URLs, window/group IDs, group titles/colors.
- It is sent only to the local native host on the same machine; the extension has no
  network access of its own and does not collect, store or transmit data elsewhere.
- What the user's MCP client does with the data is outside the extension's control;
  say so explicitly.
- Data is not sold, not used for ads, not used for creditworthiness.

Host it at a stable URL (e.g. a `PRIVACY.md` rendered from the repo) and fill in the
Data Usage form consistently.

## Helper installs the extension (External Extensions)

When the native helper ships as a package, it can ask Chrome to offer the store
extension:

- Linux: `/usr/share/google-chrome/extensions/<store-id>.json` (system-wide; similar
  paths for Chromium/Brave/Edge)
- macOS: `~/Library/Application Support/Google/Chrome/External Extensions/<store-id>.json`
  (per user) or `/Library/Application Support/Google/Chrome/External Extensions/` (all users)

```json
{ "external_update_url": "https://clients2.google.com/service/update2/crx" }
```

Chrome shows a prompt and the user must enable the extension; it cannot be installed
silently. Uninstalling the package should remove the file, otherwise Chrome may keep
offering the extension.

## Packaging the helper (later)

- npm: `npm install -g grok-tabs && grok-tabs install` already works from a published
  package (no runtime deps). The launcher bakes in the absolute node path.
- Homebrew formula: depend on `node`, run `grok-tabs install` in `post_install` or
  print a caveat telling users to run it (Homebrew discourages writing to `~`).
- macOS `.pkg` / Linux `.deb`: install the system-wide manifest
  (`/Library/Google/Chrome/NativeMessagingHosts/`, `/etc/opt/chrome/native-messaging-hosts/`,
  `/etc/chromium/native-messaging-hosts/`) with a launcher under `/usr/local/lib/grok-tabs`,
  plus the External Extensions file above.
- Consider bundling a single-file executable (Node SEA) so the host does not depend on
  the user's Node install.
