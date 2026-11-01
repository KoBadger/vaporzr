# AGENTS.md

Notes for AI agents (and anyone working alongside one) in this repository.

## Parallel sessions

More than one agent or editor can be active in this checkout at the same time.
When that happened before, one session's `git add -A` swept another session's
in-progress edits into an unrelated feature commit, and a branch switch reverted
a third session's working tree twice.

Follow these rules so it does not happen again:

1. **Never stage everything.** No `git add -A`, `git add .`, or `git commit -a`.
   Name the paths you actually changed:
   `git add apps/bot/src/server.ts apps/bot/src/__tests__/jam-request.test.ts`
2. **Do not switch, reset, or stash in the primary worktree** while another
   session may be using it. For parallel or long-running work, make an isolated
   worktree and do it there:
   `git worktree add ../vzr-work -b fix/thing origin/master`
   Remove it when you are done: `git worktree remove ../vzr-work --force`
3. **Check before you commit.** `git worktree list` and `git status --short`
   should show only what you expect. If a file you never opened is modified,
   stop and ask rather than committing or reverting it.
4. **Say what you are about to touch** when handing work between sessions, and
   prefer small PRs over long-lived dirty trees.

## Before you push

CI runs these; run them locally first.

```sh
npm run typecheck          # all workspaces
npm test -w @vaporzr/bot   # vitest
npm run format:check       # prettier
npm run viz:check          # syntax + handshake checks for the inline HTML scripts
```

`npm run viz:check` is required whenever you edit `apps/bot/public/*.html`. Those
files carry their JavaScript inline in plain ES5-style `var` blocks and have no
bundler step, so a syntax slip ships straight to the browser.

## Commit and PR titles

Conventional commits are enforced by the `semantic-pr-title` check:

```
fix(bot): stop leaking resolver errors
feat(decks): add a guided simple view
docs: add AGENTS.md rules for parallel agent sessions
```

## Code scanning

`CodeQL` is a required check. A PR that leaves an alert open in the code it
touches fails with "New alerts in code changed by this pull request" even when
every test passes. If a finding is genuinely not exploitable, dismiss it on the
Security tab with a written justification instead of leaving it open.
