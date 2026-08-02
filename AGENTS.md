# Pi Review Guidance

Pi is a local-first, project-centered Agent workbench. Review changes against the current code and tests, not removed prototype flows.

## Code Review Rules

### Trusted Workspace semantics

- Bound project sessions use the selected persistent Workspace directly through Pi-native tools.
- Do not reintroduce copied or disposable project snapshots, size or file-count gates, or obsolete `request_verification` approval cards as current policy.
- Historical verification records may remain for provenance, but they must not control current status or block fresh native verification.

### Approval and secret boundaries

- Project-local native reads and writes follow the conversation execution policy. External effects and archival writes still require their explicit confirmation contract.
- Browser and public state must never expose credentials, absolute project roots, raw private logs, hidden reasoning, or model and tool secrets.

### Durable recovery

- Migration and normalization must be idempotent, preserve audit provenance, and avoid repeated paid model work or duplicate external effects.
- A retired legacy failure must not reopen active failure UI. A genuinely current failed verification must remain visible and actionable.

### Review output

- Prioritize correctness, data loss, authorization bypass, privacy leaks, non-idempotent recovery, and disagreement between server state and UI state.
- Cite the exact file and line, then explain the trigger, impact, and smallest safe fix. Leave formatting checks to CI.
