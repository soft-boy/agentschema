---
name: commits-and-prs
description: Write commits and pull requests that are easy to review. Use when committing changes, writing a commit message, or opening or describing a pull request.
---

# Commits and pull requests

## Before committing

1. Read `git status` and `git diff`, so you know exactly what's going in.
2. Run the project's tests and linter. If you can't, or they fail, say so.
3. Check for secrets, debug code and unrelated changes, and leave them out. Stage specific files rather than everything.
4. Commit only when asked. Never commit directly to the default branch unless told to; make a branch first.

## Commit messages

Match the style in `git log` first. If there isn't one:

- Start with a short summary in the imperative, under about 70 characters: `Fix retry when the token has expired`.
- Add a body when the reason isn't obvious. Explain why, not what; the diff shows what.
- Make one commit per logical change.

## Pull requests

Follow the repository's pull request template if it has one. Otherwise:

```markdown
## What changed
One or two sentences.

## Why
The problem this solves, with a link to the issue if there is one.

## How it was tested
What you ran, and what you didn't cover.

## Notes for the reviewer
Risks, follow-ups, or anything worth a closer look. Leave this out if there's nothing.
```

- Keep it to one purpose; suggest splitting a change that does two unrelated things.
- Be accurate about testing. Never say something was tested if it wasn't.
- If you can't push or open the pull request from here, give the description as text to paste.
