# Security Policy

## Supported versions

Only the **latest release** on the [releases page](https://github.com/owengregson/Epo/releases)
receives security fixes. Epo is a self-contained desktop app — updating is
always a drop-in replacement (your local database and session data carry
over) — so there are no maintained older lines to backport to.

| Version | Supported |
| ------- | --------- |
| Latest release | ✅ |
| Anything older | ❌ — update to the latest release |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting instead:
[Report a vulnerability](https://github.com/owengregson/Epo/security/advisories/new)
(Security tab → *Report a vulnerability*). Reports are private to the
maintainer until a fix ships.

Include what you can of:

- the Epo version (About screen, or the release tag you installed),
- your OS and version (macOS or Windows),
- what an attacker can do (e.g. read the local database or stored session
  from another app, escape the renderer sandbox, execute code via IPC,
  exfiltrate credentials), and
- reproduction steps or a proof-of-concept.

You can expect an acknowledgement within a week. Confirmed vulnerabilities
are fixed in the next release, and the advisory is published once the fix
is available.

## Scope notes

- Epo runs everything **locally**: an Electron main process, a renderer UI,
  and a local SQLite (better-sqlite3) event store. Anything that crosses a
  trust boundary — IPC between renderer and main, preload exposure, handling
  of data fetched from Instagram, and how session credentials are stored on
  disk — is **in scope** and especially interesting.
- Vulnerabilities in upstream dependencies (Electron, better-sqlite3, …)
  belong upstream; report them to those projects. How **Epo configures or
  exposes** those dependencies is in scope here.

## Not a security report

Epo automates actions on an Instagram account, which may violate
[Instagram's Terms of Use](https://help.instagram.com/581066165581870).
Account restrictions, blocks, or bans that result from using Epo are a
consequence of that automation — **not a security vulnerability** — and are
out of scope for this policy. You use Epo at your own risk.
