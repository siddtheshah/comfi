---
name: comfi-task-management
description: Manage and execute tasks in TASKLIST.md following the ComFi subagent protocol. Use when discovering unclaimed tasks, calculating deadlines, claiming tasks in Commit 1, handling git synchronization/rebasing, verifying changes with tests, and completing tasks in Commit 2.
---

# ComFi Task Management Skill

This skill provides step-by-step execution workflows for discovering, claiming, implementing, and completing tasks in `TASKLIST.md` according to the ComFi subagent protocol.

---

## 1. Operating Rules & Constraints

1. **One Task Per Session**: A subagent must claim and complete exactly **one** task during its execution run.
2. **Two Commits Per Task**:
   - **Commit 1**: Claim task in `TASKLIST.md` with self-assigned deadline. No application code changes allowed in this commit.
   - **Commit 2**: Deliver completed code changes, updated tests, and mark task completed (`- [x]`) in `TASKLIST.md`.
3. **Continuous Verification**: `npm test` and `npm run typecheck` must pass before Commit 2 is created.
4. **Immediate Termination**: Once Commit 2 is pushed, conclude the session immediately. Never pick up a second task in the same run.

---

## 2. Step-by-Step Task Lifecycle

### Phase 1: Discover & Select an Eligible Task
1. Read [`TASKLIST.md`](../../TASKLIST.md).
2. Scan for candidate tasks that:
   - Are marked unchecked: `- [ ]`
   - Are unclaimed (contain no `[Claimed: ...]`), **OR** have an expired deadline where `current_time > deadline`.
3. Pick a single task suitable for autonomous execution.

### Phase 2: Commit 1 — Claim & Deadline

1. **Choose an Agent Name**:
   Use a descriptive name or area identifier (e.g., `Subagent-Web-Wallet`, `Subagent-Gov-Actions`, `Subagent-Testing-01`).

2. **Calculate a Realistic Deadline**:
   Inspect current time and add a realistic time window (e.g. 1–2 hours):
   Format: `YYYY-MM-DDTHH:MM:SSZ` (ISO-8601).

3. **Update `TASKLIST.md`**:
   Replace:
   ```markdown
   - [ ] Implement built-in ComFi In-Browser Web Wallet
   ```
   With:
   ```markdown
   - [ ] [Claimed: Subagent-Web-Wallet | Deadline: 2026-10-01T14:30:00Z] Implement built-in ComFi In-Browser Web Wallet
   ```

4. **Commit & Push Commit 1**:
   ```bash
   git add TASKLIST.md
   git commit -m "chore(task): claim 'Implement built-in ComFi In-Browser Web Wallet' by Subagent-Web-Wallet [deadline: 2026-10-01T14:30:00Z]"
   git push origin <branch>
   ```

5. **Concurrency & Conflict Handling**:
   If `git push` is rejected due to remote updates:
   ```bash
   git pull --rebase origin <branch>
   ```
   If another agent claimed this exact task during the rebase:
   - Abort your claim: `git reset --hard HEAD~1`
   - Select another unclaimed task from `TASKLIST.md` and restart Phase 2.

### Phase 3: Implement & Validate

1. Modify necessary files in the target package (`apps/web`, `apps/testing`, `services/sponsor-api`, `programs/comfi`).
2. Adhere strictly to repository rules:
   - Run tests after every change: `npm test`
   - Zero failure evasion: Do not use `try-catch` to suppress genuine errors; escalate on invalid parameters.
   - Run typechecks: `npm run typecheck`

### Phase 4: Commit 2 — Completion & Status Update

1. **Update `TASKLIST.md`**:
   Change the claimed line to completed:
   ```markdown
   - [x] [Completed: Subagent-Web-Wallet] Implement built-in ComFi In-Browser Web Wallet
   ```

2. **Commit & Push Commit 2**:
   ```bash
   git add <modified_files> TASKLIST.md
   git commit -m "feat(web): implement built-in ComFi in-browser web wallet"
   git push origin <branch>
   ```

### Phase 5: Immediate Termination
- Verify both commits are cleanly pushed.
- Confirm local working tree is clean (`git status`).
- Terminate the run immediately.

---

## 3. Handling Expired Deadlines & Rescuing Tasks

If a task is marked:
```markdown
- [ ] [Claimed: Agent-Alpha | Deadline: 2026-10-01T12:00:00Z] Add interactive network switcher
```
And the current time is `2026-10-01T13:00:00Z` without a completion commit (`- [x]`), the task is considered abandoned.

An incoming subagent may reclaim it by:
1. Checking git history for partial work:
   ```bash
   git log -n 5 --oneline
   ```
2. Overwriting the claim in `TASKLIST.md`:
   ```markdown
   - [ ] [Claimed: Subagent-Rescue-01 | Deadline: 2026-10-01T15:00:00Z] Add interactive network switcher
   ```
3. Committing and pushing Commit 1 as usual.
