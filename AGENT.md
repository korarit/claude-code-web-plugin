# AGENT.md — AI Development Workflow Rules

This file defines mandatory working rules for all AI agents working in this repository.
Follow these rules strictly unless the user explicitly overrides them.

## 1. Feature / Issue Documentation (Mandatory)

### 1.1 New Feature
- When starting a new feature, you MUST create a design/change doc first, before writing code.
- Location: `ai-dev-docs/feature/`
- Filename format: `YYYYMMDD-<feature-name-kebab-case>.md`
  - Example: `ai-dev-docs/feature/20261103-user-auth.md`
  - `YYYYMMDD` = current date in UTC.
  - `<feature-name-kebab-case>` = short, lowercase, hyphen-separated name.
- Content must include at minimum:
  1. Goal / Background
  2. Scope (In / Out)
  3. Proposed approach(es)
  4. File-level change plan
  5. Test plan

### 1.2 Issue / Bugfix / Change Request
- When working on an issue, bugfix, or small change request, you MUST create a doc first.
- Location: `ai-dev-docs/issue/`
- Filename format: `YYYYMMDD-<issue-name-kebab-case>.md`
  - Example: `ai-dev-docs/issue/20261103-fix-login-timeout.md`
- Content must include at minimum:
  1. Problem statement / Reproduction
  2. Root cause hypothesis
  3. Proposed fix(es)
  4. File-level change plan
  5. Test / verification plan

### 1.3 Rules
- One file per feature/issue. Never mix multiple features in one doc.
- Update the doc if the plan changes during implementation.
- If unsure whether it is a feature or an issue, ask the user, default to `issue/`.

## 2. Commit Strategy

1. **Small, incremental commits only.** NEVER push one large monolithic commit.
2. **Order by dependency.** Commit in dependency order: e.g., types/utils -> core logic -> UI/integration -> tests/docs.
3. **Atomic commits.** Each commit must be a single logical unit, buildable, and clearly described.
4. **No new branch unless instructed.** Work directly on the current branch. Create a new branch ONLY when the user explicitly orders it.
5. Before each commit, run `git status` and `git diff` and stage only intended files. Never commit secrets.

## 3. Solution Proposal Rule (3 Options + Recommendation)

Before editing or adding ANY code, you MUST:

1. Think through possible implementation approaches.
2. ALWAYS present the **3 best options** to the user, with pros/cons for each.
3. ALWAYS include your **recommended solution** at the end. The recommendation may be:
   - One of the 3 options alone, OR
   - A combination of them.
4. Do NOT implement until the user selects an option, except for trivial/typo-level fixes.

Format for proposals:

```markdown
### Option 1: <title>
- Pros: ...
- Cons: ...

### Option 2: <title>
- Pros: ...
- Cons: ...

### Option 3: <title>
- Pros: ...
- Cons: ...

### Recommended: <Option N or Combined>
- Reason: ...
```

## 4. Code Structure Reference

- Canonical code structure is defined in `ai-dev-docs/code-structure.md` (DDD modular monolith + shared `core`).
- All new code MUST follow that structure and its dependency rules unless `code-structure.md` is updated first.
