# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Product-specific design decisions

- The interface is Simplified Chinese and stays compact without using micro typography or exposing every secondary detail by default.
- Use warm neutral surfaces with deep teal only for actions and state emphasis.
- Avoid hero layouts, oversized type, giant cards, dashboard metrics, and decorative empty space.
- The desktop source of truth is a 1440 × 1024 three-column project workflow workspace: projects and runs, one current artifact or action, and evidence/context.
- Provider switching and Skill package management may borrow PI WEB's compact control-plane behavior, but the first prototype stays local and does not collect API keys or run remote installs.

## Shell-stage product constraints (2026-07-22)

- The official working directory is `/Users/yuzhou4tc/Public/pi Agent`; future implementation and product files should live there.
- Do not describe Pi Agent as a Codex project-continuation tool or assume work begins in Codex and continues here.
- Evolve the center workspace only around the validated V1 workflow below; do not add unrelated narratives, large cards, dashboard metrics, or generic workflow content.
- Keep the Skills entry in the top-right only. The bottom-left entry is Settings, which opens a compact quick-settings surface with an explicit path to full settings.
- The shell-stage Skill catalog is empty. The first real capability must support the validated workflow below; do not fill the catalog with speculative packages.
- Do not use a persistent right-side pending-confirmation queue. Future confirmations belong inline in a dedicated planning, discussion, or brainstorming flow; that future mode is documented but must not be implemented yet.
- Explore the left navigation as `folder -> project -> multiple conversations`, including creating and switching conversations inside a project. Treat this as a future information-architecture direction, not proof of the product's central purpose.

## Validated product direction (2026-07-22)

- Pi Agent is a project-centered personal workflow player: the product centers long-lived projects, while a workflow engine repeatedly advances them and preserves state.
- Treat the project as the user-facing primary object, a workflow as a reusable method, a run as one execution, a conversation as the intervention surface, a Skill as a method used by a step, and a tool or script as the concrete action.
- Codex is the workflow factory and repair shop for open-ended creation, modification, and recovery. Pi Agent is the lightweight player for bounded, validated, recurring workflows. Do not position the difference as model choice or code versus content.
- V1 should prove one complete workflow, not a generic workflow marketplace or a broad personal-AI operating system.
- Build and validate the clickable frontend workflow before wiring real services. Treat its buttons, states, inline confirmation, and failure-recovery path as the implementation contract; replace fixtures incrementally instead of redesigning the flow in the backend phase.
- The first workflow is `weekly source monitoring -> candidate filtering -> five-minute guide -> user-selected staged close reading -> Zotero/Obsidian archival -> proposed project-state update`.
- Deterministic scripts handle collection, cursors, normalization, deduplication, rule filtering, and simple heat signals. AI handles semantic relevance, final selection, explanation, close reading, and proposed project implications. Run MinerU only for the final selected papers.
- A run prepares on schedule and waits for review. Project-scoped reads are allowed by default; every external or project write requires an exact preview and explicit confirmation. The user may select individual changes and confirm the selected batch once, with confirmations shown inline rather than in a persistent queue.
- A human-readable Markdown project-state file is the source of truth. Pi Agent's database is only an index, cache, and run-history store.
- Zotero owns bibliographic records, PDFs, the five-minute guide, and a link to the full note. Obsidian owns the canonical close-reading note. The project-state file stores only confirmed project implications, decisions, open questions, next actions, and citations.
- Close reading is progressive (`research question -> method/mechanism -> experimental evidence -> project relationship`) and produces one evolving Obsidian note per paper; weekly reports are indexes rather than mixed multi-paper notes. Obsidian writes still require a displayed write preview and explicit approval.

## Visual hierarchy decisions (2026-07-22)

- Minimalism means fewer default-visible layers, not smaller and denser text. Desktop working text should normally be 12–13 px or larger; mobile working text should normally be 13–15 px or larger.
- Candidate lists answer two questions before any click: `what the paper is about` with a compact selection summary, then `how it matters to the project`. Heat signals, evidence scope, and other secondary material use progressive disclosure, with at most one candidate expanded at a time. Do not place a raw long abstract directly in the list.
- The right context rail separates `current evidence` and `project state` into mutually exclusive views. Do not restore one long mixed stack of evidence, run records, decisions, questions, and next actions.
- Mobile uses one primary surface at a time (`projects`, `run`, or `evidence`), 44 px core tap targets, and an opaque sticky action area that cannot reveal content underneath it.
