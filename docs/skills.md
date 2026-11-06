# `skills/`

Instructions the agent loads when it needs them, rather than carrying them in its system prompt. Each folder is a [skill](https://platform.claude.com/docs/en/managed-agents/skills): a `SKILL.md` plus any files it needs. Everything in the folder is uploaded to Anthropic and attached to the agent.

```
skills/
└── code-review/
    ├── SKILL.md
    └── checklist.md
```

```markdown path=skills/code-review/SKILL.md
---
name: code-review
description: Review code for bugs and missing tests. Use when asked to review a change.
---

Go through the change one file at a time, and report findings by file and line. See checklist.md.
```

## `SKILL.md`

| Field | Rules |
|---|---|
| `name` | Required. Must match the folder. Lowercase letters, digits and hyphens, up to 64 characters, without the words `anthropic` or `claude` |
| `description` | Required, up to 1,024 characters, with no XML tags. It's how the agent decides when to load the skill, so say when to use it |

The file must be named exactly `SKILL.md`. The body holds the instructions.

## Other files

Any other files in the folder, at any depth, are uploaded with it, keeping their layout. They don't need to be Markdown, and may be binary.

- Hidden files and `node_modules` are left out.
- Symbolic links aren't followed, in case one points outside the agent.
- A skill's files can add up to 30 MB.
- `check` scans them for secrets, the same as every other file.

A `.md` file directly in `skills/` is an error, because each skill is a folder. Other files directly in `skills/` are ignored.

## Limits

An agent can have up to 500 skills, counting these and the ones listed under `skills` in [`agent.md`](agent.md#skills).

## How they deploy

Skills deploy first, because the agent refers to their IDs and versions.

- A new skill is created by uploading its whole folder.
- Any change to a file's path or contents uploads the whole folder again as a new version. Its hash in the lock comes from each file's path and SHA-256.
- The agent's `skills` list gets each one pinned to its version: `{type: custom, skill_id, version}`. So a changed skill also updates the agent, and a session runs exactly what was deployed.

Test copies and live copies of an agent can share a skill while pinning different versions. See [Library](library.md).
