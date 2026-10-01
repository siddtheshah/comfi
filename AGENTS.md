# Subagent Protocol

Rules and task claiming protocol for subagents working in the `comfi` repository.

---

## 1. Operating Rules (CRITICAL)

- **Shared `next-release` Branch Workflow**: Subagents do not commit directly to `main` or create individual feature branches. All subagents collaborate on a single shared branch named `next-release` to allow gating changes before they reach `main`.
  - Work on `next-release`: Always ensure you are on `next-release` (`git checkout next-release && git pull --rebase origin next-release`).
  - Commit 1 (task claim) must be pushed to `origin next-release` immediately to lock the task and avoid collisions.
  - Concurrency conflicts during push must be resolved via `git pull --rebase origin next-release`.
  - Commit 2 (completion) is pushed directly to `origin next-release`. Promoted merges from `next-release` to `main` are gated.

- **Task Management**: [`skills/comfi-task-management/SKILL.md`](./skills/comfi-task-management/SKILL.md) — Detailed rebase, collision, and rescue workflows. 

- **Testing & Verification**: [`skills/comfi-testing/SKILL.md`](./skills/comfi-testing/SKILL.md) — Testing invariants, console simulator, and command reference.

- **Code Review**: [`skills/comfi-code-review/SKILL.md`](./skills/comfi-code-review/SKILL.md) — Independent, unbiased read-only subagent review protocol before final commit.

---

## 2. Reference Skills

- **Solana Validation**: [`skills/comfi-solana-validation/SKILL.md`](./skills/comfi-solana-validation/SKILL.md) — Anchor build and localnet deploy checks.
