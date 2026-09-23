# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities in this fork to
**157722763+kern0x1b@users.noreply.github.com**. Do not open a public issue.

Include the plugin version (or commit), your Paseo version, steps to reproduce, and the impact you
believe the issue has. Never include a real token, a Keychain item value, or the contents of a
credentials file.

You can also use
[GitHub Security Advisories](https://github.com/kern0x1b/paseo-usage-sidebar/security/advisories/new).

If the issue is in a feature this fork did not change, please also report it to the
[upstream project](https://github.com/RUIIIOVO/paseo-usage-sidebar).

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | 3 business days |
| Initial assessment and severity | 10 business days |
| Fix released, or a dated plan if the fix takes longer | 90 days |

You will be told when the fix ships. If you want credit in the release notes, say so in your
report; reports are otherwise handled without attribution.

We ask that you give us 90 days before disclosing publicly, and we will not ask you to sign an NDA.
If a vulnerability is being actively exploited, we will move faster and coordinate with you.

## Safe harbour

We will not pursue or support legal action against anyone who, in good faith, discovers and reports
a vulnerability under this policy — provided you:

- test only against your own installation and your own accounts;
- do not access, modify, or exfiltrate data belonging to anyone else;
- give us reasonable time to respond before disclosing.

If you are unsure whether something is in scope, ask before testing.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.1.x   | Yes       |
| < 1.1   | No        |

## Scope

In scope:

- how the plugin locates and reads Claude account usage, including which Keychain item and which
  `CLAUDE_CONFIG_DIR` it derives for a custom provider;
- any place a credentials path, token, or account identifier could be logged or surfaced in the UI.

Out of scope:

- vulnerabilities in Paseo itself, or in the `@getpaseo/plugin` SDK — report those to
  [Paseo](https://paseo.sh);
- how Claude Code or the OS Keychain store credentials;
- findings that require an attacker to already have local code execution as the user, or read
  access to the OS Keychain.

## Design notes

The plugin reads Paseo's own usage data and, for a custom Claude provider, the usage the OS Keychain
already holds for that account; it derives the Keychain service name from the account's config
directory and does not read, copy, or transmit the token itself. It makes no outbound network calls
of its own. Account paths are treated as sensitive and must not be committed to this repository — in
code, tests, or fixtures.
