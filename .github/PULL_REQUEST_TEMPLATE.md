# Summary

<!-- What does this PR change, and why? Link the issue it closes if one exists (e.g. "Closes #12"). -->

## Type of change

<!-- Check all that apply. -->

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (existing behavior, stored data, or config changes)
- [ ] Refactor / internal cleanup (no user-visible behavior change)
- [ ] CI / tooling / docs

## Testing done

<!-- Run the full local gate and check what passed. -->

- [ ] `npx tsc --noEmit` — typecheck passes
- [ ] `npm run lint` — lint passes
- [ ] `npm test` — jest suite passes
- [ ] `npm run build` — esbuild bundle succeeds
- [ ] Ran the app (`npm start`) and exercised the changed behavior

<!-- Describe any manual testing beyond the checkboxes: what you ran, on which OS, what you observed. -->

## Screenshots

<!-- Required for any UI change: before/after of the affected view. Delete this section for non-UI changes. -->

## Checklist

- [ ] The change is focused — no unrelated refactors or drive-by edits
- [ ] New behavior is covered by tests where practical
- [ ] No secrets, credentials, or personal account data in the diff
- [ ] Database schema / stored-state changes handle existing local data (migration or explicit note)
- [ ] Docs updated if behavior or setup changed
