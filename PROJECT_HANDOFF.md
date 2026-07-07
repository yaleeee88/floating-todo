# Project Handoff

## Project Basics
- Name: floating-todo / 悬浮待办
- Purpose: Cross-platform floating desktop todo widget built with Tauri 2.
- Current stage: Public app/repository at version 0.3.1.
- Main repo: https://github.com/BUG-gao/floating-todo
- Related repos: None documented.
- Important URLs: GitHub Releases for distribution.

## Current Progress
- Completed: macOS/Windows floating todo app with local-only storage, reminders, global shortcut, tray/menu bar integration, autostart, import/export, and build workflow.
- In progress: Supply-chain IOC scheduled scan workflow is installed as an external security validation consumer.
- Not started: Code signing/notarization, optional multi-device sync, custom global shortcut, richer natural language parsing.

## File Structure
- Key directories: `src/` frontend, `src-tauri/` Rust/Tauri backend and bundle config, `.github/workflows/` release automation, `legacy-macos-swift/` archived reference implementation.
- Key entrypoints: `src/index.html`, `src/styles.css`, `src/main.js`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`.

## Core Logic
- Main workflows: Local todo management for today/tomorrow/day after tomorrow; optional reminder notifications; window/tray controls; import/export JSON backup.
- Data model / permissions: User data is stored locally in browser `localStorage`; app uses Tauri permissions/plugins for shortcut, notification, dialog, opener, tray, and autostart features.
- Integrations: Tauri 2 plugins, GitHub Actions release builds, and scheduled Supply-Chain IOC scanning via the private `BUG-gao/supply-chain-intel-platform` Action checkout pattern.

## Environment and Deployment
- Branch strategy: Not documented.
- Local commands: `npm install`, `npm run dev`, `npm run build`.
- Test environment: Not documented.
- Production environment: GitHub release artifacts.
- Deployment process: GitHub Actions builds macOS and Windows installers for `v*` tags.
- Secrets locations, without values: `SUPPLY_CHAIN_INTEL_ACTION_TOKEN` is stored as a GitHub Actions repository secret and must have read access to `BUG-gao/supply-chain-intel-platform`. Optional `SUPPLY_CHAIN_INTEL_FEED_URL` can be stored as a repository variable when a hosted intelligence feed is available.

## Verification Status
- Tests/builds run: 2026-06-22 text search after authorization-file removal; remaining matching terms are third-party dependency metadata in `package-lock.json`.
- Documentation checks run: 2026-06-22 README update instructions reviewed with `sed`; whitespace checked with `git diff --check`.
- Deployment checks: Supply-Chain IOC Scan workflow run `28849296042` completed successfully on 2026-07-07 after the private Action checkout fix.
- Known passing flows: Not verified in this session.
- Supply-chain scan workflow: fixed on 2026-07-07 to check out the private Action repo with `SUPPLY_CHAIN_INTEL_ACTION_TOKEN`, use a repository-local empty test feed by default, allow `feed_url`/`SUPPLY_CHAIN_INTEL_FEED_URL` override, and manually verified run `28849296042` succeeded.

## Known Risks and Constraints
- Technical risks: macOS/Windows builds are unsigned, so first launch and downloaded macOS updates may be blocked by platform security prompts.
- Product/legal/platform boundaries: Project-level authorization file and README authorization claim were removed on 2026-06-22. Third-party dependency terms in lockfiles must still be honored.
- Operational notes: No project-level replacement terms are currently documented.
- Operational notes: The supply-chain scan workflow depends on a token secret for private Action checkout; rotating or removing that secret will break scheduled scans before repository checkout completes.

## Next Development Plan
- P0: Decide and document the intended project terms if distribution continues.
- P1: Add signing/notarization plan for macOS and Windows releases.
- P2: Continue roadmap items from README as capacity allows.

## Change Log
- 2026-06-22: Added README troubleshooting steps for macOS users who overwrite-install an updated app and still see "damaged" with no Security & Privacy bypass record.
- 2026-06-22: Removed project-level authorization file and README badge/section; verified no project-level authorization references remain outside third-party dependency metadata.
- 2026-07-07: Updated scheduled Supply-Chain IOC Scan workflow to work with a private scanner Action repository by checking it out using `SUPPLY_CHAIN_INTEL_ACTION_TOKEN`; added `.github/supply-chain-ioc-feed.json` empty test feed for scheduled runs.
- 2026-07-07: Stored `SUPPLY_CHAIN_INTEL_ACTION_TOKEN` as a repository secret and verified workflow dispatch run `28849296042` succeeded, including private Action checkout, scan execution, and SARIF upload.
