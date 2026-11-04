---
name: code-review
description: Review code changes for bugs, security problems and missing tests, and report findings by file and line. Use when asked to review a diff, pull request, branch or file.
---

# Code review

1. Work out what changed and what it's meant to do. Read the diff, then the description or the request behind it.
2. Read the code around each change, not only the changed lines. Callers and tests often show what the change broke.
3. Run the tests if you can. Say so if you couldn't.
4. Go through [checklist.md](checklist.md).
5. Before reporting a finding, trace how it would actually happen. Drop anything you can't back up with a concrete input or sequence of events.

## Reporting

List findings most severe first:

```
path/to/file.js:42 [blocker] One sentence stating the defect.
What triggers it, and what goes wrong. The fix, if it's clear.
```

- **blocker**: wrong behavior, data loss, or a security problem. Must be fixed before merging.
- **should fix**: a real problem with limited reach, such as a missing test for new logic.
- **nit**: optional. Leave these out unless asked, or keep them to a few.

End with one line: whether the change is ready to merge, and what you did or didn't verify. If you found nothing, say that plainly, and don't invent findings to look thorough.

Comment on the change in front of you. Mention existing problems only when the change makes them worse.
