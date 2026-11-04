---
name: debugging
description: Find the root cause of a bug, then fix it with a test that proves it. Use when something crashes, fails, gives a wrong result, or a test is failing, and the cause isn't already known.
---

# Debugging

Fix the cause, not the symptom. Don't change code until you can explain why the bug happens.

1. **Reproduce it.** Find the smallest command or input that shows the failure, and read the complete error. If you can't reproduce it, say so and list what you tried, rather than guessing at a fix.
2. **Write a failing test,** if the project has tests. It should fail for the reason you're chasing.
3. **Find the cause.** Follow the failing value back to where it first goes wrong. Check recent changes with `git log` and `git blame`, and use `git bisect` if it used to work. Test one idea at a time, and say which ones you ruled out.
4. **Fix it** with the smallest change that addresses the cause. If the same mistake appears elsewhere, fix those too or list them.
5. **Verify.** The new test passes, the original reproduction no longer fails, and the rest of the test suite still passes.

Remove any debug logging you added.

Finish by saying what caused the bug, what you changed, and how you verified it. If the fix is partial, or you ran out of ideas, say that plainly.

Don't make a failure go away by deleting or weakening a test, adding a broad `catch`, or adding a retry or a sleep, unless that's truly the right fix and you explain why.
