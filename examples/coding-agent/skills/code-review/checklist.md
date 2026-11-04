# Review checklist

## Correctness
- Does it do what the description says, in every case it claims to handle?
- Empty, null, zero, very large and duplicate inputs
- Off-by-one errors, boundaries and date or time zone handling
- Errors: are they handled, or silently swallowed? Is a failure ever reported as success?
- Concurrency: shared state, retries, and two requests arriving at once

## Security
- Untrusted input reaching SQL, a shell, a file path, a URL or HTML
- Missing authorization checks, not only authentication
- Secrets in code, logs or error messages
- New dependencies: are they needed, and are they maintained?

## Tests
- Is new logic tested, including how it fails?
- Would these tests fail if the code were wrong?
- For a bug fix: is there a test that failed before the fix?

## Compatibility
- Public APIs, file formats, database schemas, and configuration: does anything existing break?
- Is a migration needed, and can it be rolled back?

## Fit
- Does it follow how the surrounding code does the same thing?
- Does it duplicate something that already exists?
- Is the docs or changelog now out of date?
