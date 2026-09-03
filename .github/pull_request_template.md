<!-- Keep this short — under 200 words, never more than a screen. Reviewers read the diff;
this tells them what to look for and why. Cut anything the diff already says: no file-by-file
walkthrough, no recap of what you tried on the way. Detail worth keeping goes in a code
comment, next to the thing it explains. -->

## What

<!-- One or two sentences. What changed, and what a caller of the library or the MCP server
sees differently. -->

## Why

<!-- The problem, not the patch. Link the issue this follows from, and name anything open it
subsumes or deliberately leaves alone. If SPEC.md and the code disagreed, say which one you
treated as correct. -->

## Checks

- [ ] `pnpm install --frozen-lockfile && pnpm -r --include-workspace-root build`
- [ ] `pnpm -r --include-workspace-root test`
- [ ] Golden vectors untouched — or, if the wire format moved deliberately, the version prefix
      moved with it and this PR says so in its title
- [ ] `CHANGELOG.md` has an `[Unreleased]` entry for anything user-visible
- [ ] Docs that would now be wrong are updated: `SPEC.md`, `README.md`, `mcp/README.md`,
      `mcp/worker/README.md`, `AGENTS.md`
- [ ] New surface on the money path: say what a hostile counterparty gets from it, or say
      "nothing new"
