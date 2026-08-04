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

### Conversation activity and scheduling

- Keep independent conversations below project conversations and collapsed by default. Worker groups also start collapsed and must not reopen on refresh.
- Show only safe public progress and tool activity. Never expose or persist private chain-of-thought. Completed activity collapses after a durable final answer, while failed, stopped, or user-blocked activity remains open and inspectable.
- New Worker tasks derive their title deterministically from the first explicit user message without another model call. Never overwrite an assigned or manually edited title.
- Monthly candidate refresh follows the `Asia/Shanghai` Monday `00:00` natural-week boundary. Persist real scan observation evidence, retry task-level failures without advancing the week watermark, and never derive the displayed coverage window from the browser clock.

### Retrospective skill and control density

- Treat Better Harness as a manual or low-frequency, read-only retrospective Skill. It summarizes bounded run evidence, proposes improvements, and compares later reports; any actual prompt, Skill, settings, or code change returns to normal review and execution.
- Keep only the artifact toggle, combined model control, and one `更多` entry in the normal-work top bar. Put per-turn capabilities, conversation paths, process detail, and local notifications behind `更多`.
- Use one composer `添加` menu for project-file context and local materials. While work is running, replace the lower-right send action with one square stop control; do not duplicate stop in the top bar.
- Keep the conversation-path title and actions visible while one focusable middle region scrolls through Workspace and checkpoint history.

### Journal source health and six-month recommendations

- Keep all 11 registered journal and conference sources queryable through an explicit official-primary route and a declared fallback route. A fallback success is visibly degraded and the latest completed scan preserves per-route failure evidence.
- JMLR discovery uses its official RSS feed. Preserve year-only publication precision unless a trusted source supplies a more precise date.
- Each natural-week refresh stores one recommendation snapshot inside the monthly Run. The eligible pool covers the most recent 180 days; low-precision dates use their real first-seen time without inventing a publication day.
- Prefer three current-window core papers, one high-quality unread paper, and one broader-field paper, then fill deterministically from the remaining eligible pool.
- An unread paper may appear in two consecutive snapshots, then cools down for at least one snapshot, and may appear at most three times. Reading, collecting, or dismissing it removes it from future recommendations.
