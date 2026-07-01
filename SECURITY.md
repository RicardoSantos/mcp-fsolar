# Security Policy

## Supported versions

Only the latest release on npm receives security fixes.

| Version | Supported |
|---|---|
| latest (`1.x`) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Open a [GitHub Security Advisory](https://github.com/RicardoSantos/mcp-fsolar/security/advisories/new) with:

- A description of the vulnerability and its impact
- Steps to reproduce or a proof-of-concept
- The version(s) affected

You will receive a response within 72 hours. If the report is confirmed, a patched release will be published and you will be credited in the release notes (unless you prefer to remain anonymous).

## Scope

Areas most likely to contain security-relevant issues:

- **Credential handling** — `FELICITY_USER` / `FELICITY_PASS` are RSA-encrypted before transmission; any bypass or leak of these values is in scope
- **Webhook delivery** — the `HookStore` fires HTTP POST requests to user-registered URLs; SSRF or header injection via malicious URLs is in scope
- **State file exposure** — `battery-state.json`, `battery-hooks.json`, and `battery-hook-cooldowns.json` are written to `SNAPSHOT_DIR`; path traversal or symlink attacks are in scope
- **Dependency vulnerabilities** — report upstream if the issue is in a dependency, but notify us if it directly affects this package's attack surface

Out of scope: issues that require physical access to the battery hardware or the Felicity cloud infrastructure.
