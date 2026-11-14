# Contributing

- Keep it lean: plain JavaScript (ESM), Node 18+, **no runtime dependencies**.
- Keep the extension permissions at `tabs`, `tabGroups`, `nativeMessaging`. Anything
  that needs more (page content, network, debugger) is out of scope.
- No network listeners in the product: native messaging and the Unix socket only.
- New operations go in `src/ops.js` (schema + description), `extension/background.js`
  (handler) and `src/cli.js` (command + output); MCP picks them up automatically.
  Destructive operations must default to a dry run.
- Run `npm test` and, if you touched the extension or host, the e2e test:
  `CHROME_BIN=/path/to/chromium npm run e2e`.
- Never commit private keys (`*.pem` is gitignored).
