# Pi Native Workspace verification migration review

## Product invariants

- Pi is a local-first, project-centered Agent workbench.
- A bound project conversation operates in its persistent Workspace through Pi-native tools.
- External effects and archival writes retain their explicit confirmation contracts.
- Durable state must survive reloads and restarts without repeating model calls or external effects.

## Problem being changed

Older project conversations may still contain verification records created for a copied, disposable workspace. Records such as `request_verification` and `PROJECT_WORK_VERIFICATION_WORKSPACE_TOO_LARGE` can survive the move to the persistent native Workspace. They may incorrectly keep a conversation in `verification_failed`, reopen an obsolete approval card, or teach the Agent to follow a retired verification path.

## Intended behavior

- Identify the complete legacy request and verification-attempt chain.
- Retire every linked legacy record while preserving its former status, error code, logs, and provenance for audit.
- Clear only the matching stale `lastError`, then derive the conversation status from current state.
- Make startup normalization idempotent and emit its migration event once.
- Map retired provenance through the frontend and show it as historical, not actionable.
- Keep genuinely current failed verification visible and actionable.
- Update the public harness contract to `pi-native-v1` and guide fresh verification through Pi-native Workspace tools.

## Questions for reviewers

1. Can legacy classification accidentally retire a current verification failure?
2. Can request linking or index-based chain discovery miss or misclassify records?
3. Is startup normalization idempotent and safe under repeated initialization?
4. Can clearing `lastError` or recomputing status hide another unresolved operation?
5. Do the server contract and UI agree on which verification records are active?
6. Does the new Agent guidance preserve the explicit confirmation boundary for external effects?

## Verification

Targeted tests:

```bash
node --test --test-concurrency=1 \
  server/project-work/legacyWorkspaceMigration.test.js \
  server/project-work/piSessionHost.test.js \
  server/project-work/projectWorkService.test.js \
  src/api/projectWork.test.js \
  src/components/LiveProjectWorkbench.test.js
```

Full repository verification:

```bash
npm run verify
```
