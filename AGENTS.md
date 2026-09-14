# Git workflow

For any development work, follow this strategy:

1. **Open an issue first** (`gh issue create`) describing the feature/bug/etc., before writing code.
2. **Branch off `main`** for the work. Branch naming: `<type>/<short-kebab-description>`, matching existing branches in this repo — e.g. `feature/x`, `fix/x`, `chore/x`, `update/x`.
3. **Commit & push** as you go. Commit messages: a short imperative summary line (e.g. "Cancel an in-flight build when a new folder is chosen"). No `feat:`/`fix:` type prefixes — this repo doesn't use Conventional Commits. Add a body only to explain non-obvious *why*, not to restate the diff.
4. **Open a PR against `main`** with `gh pr create`, with a body that includes a closing keyword referencing the issue (e.g. `Closes #123`) so merging the PR auto-closes it.

Never commit directly to `main`. Leave merging to review — don't merge a PR unless explicitly asked to.
