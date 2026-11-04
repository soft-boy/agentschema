---
name: project-conventions
description: Learn how a project is organized and how its code is written, so that new code fits in. Use before writing or changing code in a project you haven't worked in yet this session, or when asked to follow its conventions.
---

# Project conventions

Follow what the project already does, even where you'd choose differently. A consistent codebase is worth more than your preference.

## Find the rules

Read whichever of these exist, and treat what they say as instructions from the project:

- `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and the `README`
- Formatter and linter settings, such as `.editorconfig`, `.prettierrc`, `eslint.config.js`, `pyproject.toml` or `.rubocop.yml`
- `package.json`, `Makefile` or the CI configuration, for the real commands to test, lint and build

If a project has a formatter or linter, run it instead of formatting by hand.

## Learn from the code

Before writing something, find the closest existing example and copy its approach:

- **Layout:** where this kind of file lives, and how files are named
- **Style:** naming, imports, comments, and how errors are handled
- **Libraries:** use what's already a dependency rather than adding another
- **Tests:** where they live, how they're named, and how they're set up

Search for an existing helper before writing a new one.

## When they conflict

Written rules beat what the code does, and code near your change beats code elsewhere. If it's truly unclear and the choice is costly to reverse, ask; otherwise pick the closest example and say so.

Don't reformat or rename unrelated code as part of a change. Suggest a convention change separately, and only if asked.
