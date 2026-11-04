---
name: dependency-upgrades
description: Upgrade project dependencies safely, one at a time, checking changelogs and running tests. Use when asked to update, bump or upgrade packages, or to fix a vulnerability in a dependency.
---

# Dependency upgrades

1. **See what's there.** Find the package manager from the lock file, and use it for everything; don't hand-edit the lock file. List what's outdated, such as with `npm outdated` or `pip list --outdated`.
2. **Get a baseline.** Run the tests before changing anything. If they already fail, report that first, so old failures aren't blamed on the upgrade.
3. **Plan the order.** Do security fixes first, then patch and minor versions, then major versions. Upgrade related packages together when they have to match, such as a framework and its plugins.
4. **Read the changelog** for any major version, and for anything else that touches code you depend on. Note breaking changes that affect this project, and search the code for what they mention.
5. **Upgrade one at a time.** After each, run the tests and build. Fix what broke, or undo that upgrade and report it, before moving on.
6. **Commit each upgrade separately** when asked to commit, so any one of them can be reverted.

## Reporting

Finish with a table of each package's old and new version and its result, then:

- what you changed in the code because of an upgrade
- what you left out, and why
- anything the tests don't cover, so it needs checking by hand

Be careful with packages that are new, renamed or unfamiliar: check that the name is exactly right before installing. Don't remove a version pin without finding out why it was there.
