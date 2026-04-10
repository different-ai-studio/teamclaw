---
name: create-role
description: Create a workspace role that follows the ROLE.md specification. Use when the user wants to create a new role, refine a role definition, or turn repeated responsibilities into a reusable routed role.
---

# Create Role

Use this skill to design and create a role that follows the workspace `ROLE.md` convention, and to decide how that role relates to reusable skills.

## What this creates

This workflow is for two related assets:

1. A role definition:
   - `.opencode/roles/<role-slug>/ROLE.md`

2. Optional role-specific skills:
   - `.opencode/roles/skill/<skill-slug>/SKILL.md`

The role is the routing layer. It is disclosed first and helps the model decide *when* a capability cluster should be used.

The skill is the execution layer. It is disclosed only after the role is loaded or when a normal skill is used directly.

## Directory model

Always reason from this structure:

```text
.opencode/
  roles/
    config.json
    <role-slug>/
      ROLE.md
    skill/
      <skill-slug>/
        SKILL.md
```

Key rules:

- `ROLE.md` describes the role and references role skills in `## Available role skills`
- `SKILL.md` keeps the same shape as a normal agent skill
- The role should explain responsibility and routing
- The skill should hold reusable procedural instructions

## Goal

Help the user define a role that:

- has a stable slug-style `name`
- has a short `description` suitable for `<available_roles>`
- includes clear `Role`, `When to use`, and `Working style` sections
- optionally lists role-specific skills in `## Available role skills`
- is ready to save as `.opencode/roles/<role-slug>/ROLE.md`
- includes a clear plan for whether related skills should be reused, migrated, copied, or newly created

## Collect the minimum role definition

Before writing the role, gather or infer:

1. The role's routing name
2. A short description for progressive disclosure
3. The role's responsibility boundary
4. When the model should pick this role
5. The desired working style or review style
6. Whether the role should include role-specific skills now or leave that empty
7. Whether there are existing skills that already cover the role's execution needs
8. Whether those existing skills should remain normal skills, be copied into role skills, or be migrated into role skills
9. Whether any new role-specific skill must be created because no suitable skill already exists

Ask only for the missing pieces. If the user already provided enough context, do not ask redundant questions.

## Skill relationship decisions

You must explicitly reason about the relationship between the new role and skills.

Before finalizing the role, determine:

1. Does the role need dedicated role skills at all?
2. If yes, are there already existing skills that can be used?
3. For each existing relevant skill:
   - keep it as a normal skill
   - copy it into `.opencode/roles/skill/<skill-slug>/SKILL.md`
   - migrate it into `.opencode/roles/skill/<skill-slug>/SKILL.md`
4. If no existing skill is sufficient, should a new role-specific skill be created?

Do not silently choose a migration strategy when the user likely cares. Confirm it.

Use these defaults when the user has not decided:

- If a skill is broadly reusable outside the role, recommend keeping it as a normal skill or copying it
- If a skill is tightly coupled to one role and unlikely to be reused elsewhere, recommend migrating it into role skills
- If there is no suitable skill yet, recommend creating a new role-specific skill

## Authoring rules

The generated role must follow this structure:

```md
---
name: role-slug
description: Short routing description
---

## Role
...

## When to use
- ...

## Available role skills
- `skill-name`: short description

## Working style
- ...
```

Important constraints:

- Frontmatter only contains `name` and `description`
- `name` should be lowercase kebab-case
- `description` should be concise and discriminative
- `## Available role skills` is optional, but if present it must use bullet lines in the form:
  - ``- `skill-name`: short description``
- Keep the role specific to a real responsibility boundary, not a vague persona

If the role requires role skills, each referenced skill should exist as:

```md
---
name: skill-slug
description: Short procedural description
---

# Skill Title

Concrete reusable instructions here.
```

Do not invent custom metadata for role skills. Keep `SKILL.md` aligned with the standard agent skill shape.

## Decision guidance

When helping the user define a role:

- Prefer narrow, clearly routable roles over broad generic experts
- Make `description` short enough to work as a routing hint
- Put detailed behavior in `## Role` and `## Working style`
- Put triggering situations in `## When to use`
- Only include role skills that genuinely belong to the role
- Separate routing guidance from procedural execution
- If the role becomes too detailed, move procedures into one or more role skills instead of bloating `ROLE.md`

## Output behavior

When the user wants you to create a role:

1. Confirm the role concept briefly
2. Collect missing information if needed
3. Explain the role/skill split if the user has not clearly decided it
4. Identify existing relevant skills and ask whether to keep, copy, or migrate them
5. If a new role-specific skill is needed, propose its `SKILL.md`
6. Propose the final `ROLE.md`
7. If the user wants file creation, save it under `.opencode/roles/<role-slug>/ROLE.md`
8. If role skills are part of the plan, create or update them under `.opencode/roles/skill/<skill-slug>/SKILL.md`

If the user only wants help designing the role, provide the finished `ROLE.md` content without assuming file writes.

## Recommended conversation flow

Use this order when the request is underspecified:

1. Clarify the role's responsibility and routing boundary
2. Clarify what should stay in the role body versus what should become skill instructions
3. Audit existing skills that may already cover part of the role
4. Confirm copy vs migrate vs keep-as-normal-skill
5. If needed, design new role skills
6. Produce the final `ROLE.md`
7. Produce any needed `SKILL.md` files
