# `system_prompt/`

A long system prompt can be split into files. Every file in `system_prompt/`, at any depth, is added after the body of [`agent.md`](agent.md), in the order `tree` lists them, with a blank line between each one. A system prompt with parts for the role, the rules and the house style can live in a file each, and a folder can group the ones that go together.

```
my-agent/
├── agent.md                  # the start of the system prompt
└── system_prompt/
    ├── 01-role.md
    ├── 02-rules/
    │   ├── privacy.md
    │   └── tone.md
    └── 03-examples.md
```

```markdown path=agent.md
---
name: Support
model: claude-opus-5-5
---

You answer questions about our product.
```

```markdown path=system_prompt/01-role.md
You work at the front desk, and you're the first person most customers talk to.
```

```markdown path=system_prompt/02-rules/privacy.md
Never ask for a card number, and never repeat one back.
```

The agent's system prompt is then:

```
You answer questions about our product.

You work at the front desk, and you're the first person most customers talk to.

Never ask for a card number, and never repeat one back.
```

## The order

The files go in the order `tree` lists them:

- **Each folder's entries are sorted by name, character by character.** Capitals come before lowercase letters, so `Zebra.md` comes before `apple.md`, and digits come before both.
- **A folder's files go where the folder sorts**, before the next name. `02-rules/privacy.md` and `02-rules/tone.md` come after `01-role.md` and before `03-examples.md`.
- **Numbers aren't read as numbers.** `10-end.md` comes before `2-middle.md`, so number files with leading zeros, like `02-` and `10-`, to keep them in order.

This is how `tree` sorts on a Mac, and with `LC_ALL=C` on Linux. Other locales can order capitals differently, but agentschema's order is always the same, wherever it runs.

## The files

- **Any file counts,** whatever its name ends with, so `.md` and `.txt` both work.
- **Each file is taken exactly as written,** with spaces and blank lines trimmed from both ends. It has no frontmatter: a `---` block in one is part of the prompt.
- **An empty file adds nothing.**
- **Hidden files and `node_modules`** are left out, as they are everywhere in an agent.
- **A file that isn't text,** like an image, is an error.

`agent.md` can have no body at all, and then the system prompt is only these files.

## Limits

The API's limit of 100,000 characters is on the whole system prompt, `agent.md`'s body and these files together, so `check` reports it for both:

```
agent.md and system_prompt/: the system prompt is 120,104 characters; the limit is 100,000
```

A [channel's](channels.md) instructions go after all of it, and count toward the same limit.

## Deploying and running

The system prompt is part of the agent, so changing, adding or removing a file here updates the agent on the next `deploy`, and `run` warns when one has changed since the last one. Nothing in the folder is deployed as a file of its own.

## For hosts

`checkFiles` reads the folder into `instance.systemPrompt`, a list of `{ file, text }` in order. `systemPromptOf(instance)` gives the whole prompt, which is what `agentBody` sends as `system`. Give `channelSystem` the instance, not only its agent, so a channel's conversations get these files too. See [Library](library.md).
