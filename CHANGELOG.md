# Changelog

All notable changes to this fork are documented in this file. Features inherited unchanged from
[upstream](https://github.com/RUIIIOVO/paseo-usage-sidebar) are not repeated here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The panel under **Settings → Plan usage**, for setting the pins and columns up once
- An Antigravity card: 5-hour and weekly windows for Gemini and for Claude and GPT models

### Fixed
- Hiding the Plan usage entry in Paseo's sidebar settings no longer hides the meter: it moves under
  the lowest entry still shown

## [1.1.1] - 2026-09-23

### Added
- **Extra Claude accounts**: reads plan usage for custom providers that `extend` `claude` with
  their own `CLAUDE_CONFIG_DIR`, which Paseo itself does not report — shown in the panel, the
  sidebar meter, and the composer
- **Composer pill** showing the extended account's usage, with a settings toggle
- **Meter columns** (1–3), compact cells (window, percent, time to reset), reset-aware display
- Fork README with a blurred overview screenshot; English and Simplified Chinese

### Security
- Account config paths and Keychain identifiers are treated as sensitive and kept out of the
  repository, including tests and fixtures

[Unreleased]: https://github.com/kern0x1b/paseo-usage-sidebar/compare/v1.1.1...HEAD
[1.1.1]: https://github.com/kern0x1b/paseo-usage-sidebar/releases/tag/v1.1.1
