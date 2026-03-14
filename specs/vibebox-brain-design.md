# vibebox-brain Design Spec

**Date:** 2026-03-14
**Status:** Approved

## Overview

vibebox-brain is the first sub-project of vibebox — a self-hosted, Tailscale-accessible web app for capturing and organizing ideas, synthesizing them with AI, and promoting them into real development projects. It is fully file-based (YAML + git), with no database. Both humans and AI agents can read and write the same files.

---

## Scope

vibebox is a single SvelteKit app built incrementally in phases. This spec covers Phase 1.

| Phase | Scope |
|-------|-------|
| **1 — this spec** | Ideas inbox, synthesis, project tree |
| 2 | Agent monitoring — see running Claude/Copilot processes per project |
| 3 | Live/deploy status — port exposure, domain routing for internet-served projects |
| 4 | Auth layer on top of Tailscale |

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | SvelteKit 5 + Svelte 5 | Lightweight, SSR built-in, excellent for self-hosted tools |
| Runtime | Bun | Faster than Node, built-in YAML support, clean `Bun.spawn()` API |
| Adapter | `svelte-adapter-bun` | Bun-native SvelteKit deployment |
| Storage | YAML files | File-based, git-tracked, human and agent readable — no database |
| Styling | TailwindCSS | Utility-first, mobile-friendly |

---

## File Layout

```
~/projects/vibezzz/           ← this repo (vibebox itself)
└── ideas.yaml                ← global ideas inbox (pre-promotion)

~/projects/                   ← PROJECTS_DIR (configurable via .env)
└── <category>/
    └── <project>/
        ├── .git/
        └── .vibezzz/
            ├── ideas.yaml    ← project-scoped ideas
            └── meta.yaml     ← project metadata
```

### ideas.yaml schema (global and project-scoped)

```yaml
- id: 1
  content: "build a thing"
  created_at: 2026-03-14T10:00:00Z
  status: raw          # raw | promoted | implemented
  implemented_at: null
  git_tag: null        # e.g. "idea/1-build-a-thing", set when marked implemented
  project_path: null   # e.g. "js/my-app", set when promoted (global ideas.yaml only)
```

### .vibezzz/meta.yaml schema

```yaml
name: my-app
category: js
origin: brain          # brain | external
created_at: 2026-03-14T10:00:00Z
idea_id: 1             # id from global ideas.yaml; null for external projects
```

---

## AI Provider Abstraction

A pluggable `AIProvider` interface allows switching between CLI-based AI tools. Both are already authenticated on the host machine — no API keys needed.

```typescript
interface AIProvider {
  name: string
  run(prompt: string, cwd?: string): Promise<string>
}
```

Implementations:
- `ClaudeProvider` — spawns `claude --print "<prompt>"` — prompt passed as a separate argument to `Bun.spawn()`, never interpolated into a shell string (prevents injection)
- `CopilotProvider` — spawns `copilot "<prompt>"` — same safe spawn approach

Provider is selectable per-action in the UI. Adding a new provider = one new class implementing the interface. The active provider is persisted in the user's session or defaulted from `DEFAULT_PROVIDER` env var.

---

## Views

### `/` — Global Inbox

- Textarea + submit button to add a new idea
- List of all raw ideas (sorted by `created_at` descending)
- Each idea card: content, timestamp, "Promote to Project" button
- Promoted ideas shown with a muted badge, not removed

### `/synthesis`

- Provider selector (Claude / Copilot)
- "Synthesize" button — triggers on-demand AI synthesis of all raw ideas
- Output: AI-generated ranked summary with reasoning per idea
- Synthesis is stateless — output is not persisted, regenerate any time

**Synthesis prompt template:**
```
You are a creative project advisor. Below is a list of raw ideas.
Rank them from most to least promising based on originality, feasibility, and impact.
For each idea, provide a one-sentence rationale.
Return the result as a numbered ranked list.

Ideas:
<idea list, one per line>
```

### `/projects`

- Collapsible category sections (derived from `meta.yaml` category fields)
- "Resync" button at top — rescans `PROJECTS_DIR`
- Each project card: name, category, origin badge (brain/external), idea count badge
- Move button per project: select new category (or type a new one), moves dir + updates `meta.yaml`
- Click project → navigates to `/projects/[...path]`

### `/projects/[...path]` — Project Detail

- Project name and metadata
- Add idea form (writes to `.vibezzz/ideas.yaml`)
- List of project-scoped ideas with status badges
- "Mark Implemented" button per idea:
  - Runs `git tag idea/<id>-<slug>` in project directory
  - Updates `status`, `implemented_at`, `git_tag` in `.vibezzz/ideas.yaml`
- Implemented ideas shown with git tag badge

---

## Key Flows

### Promote Idea to Project

1. User clicks "Promote" on a global idea, enters project name and selects/creates a category
2. Server creates `$PROJECTS_DIR/<category>/<name>/`
3. Server runs `git init` in the new directory
4. Server writes `.vibezzz/meta.yaml` and `.vibezzz/ideas.yaml` (empty ideas list)
5. Server spawns chosen CLI with scrum agent prompt + idea content as input, in the new project directory
6. Server updates the idea in `ideas.yaml`: `status: promoted`, `project_path: <category>/<name>`
7. UI navigates to `/projects/<category>/<name>`

### Resync Project Tree

1. User clicks "Resync" in `/projects`
2. Server walks `PROJECTS_DIR` recursively, finds all directories containing `.git/`
3. For each found project:
   - If `.vibezzz/meta.yaml` exists: read it
   - If not: create `.vibezzz/meta.yaml` with `origin: external`, infer category from path
4. Projects in the tree that no longer exist on disk are flagged as `missing` in the UI — this is a transient UI-only state, not written to disk. The project entry disappears on next successful Resync.
5. UI refreshes the project tree

### Move Project

1. User clicks "Move" on a project card, selects or types a new category
2. Server renames `$PROJECTS_DIR/<old-category>/<name>/` to `$PROJECTS_DIR/<new-category>/<name>/`
3. Server updates `category` in `.vibezzz/meta.yaml`
4. UI refreshes

### Mark Idea as Implemented

1. User clicks "Mark Implemented" on a project-scoped idea
2. Server runs `git tag idea/<id>-<slug>` in the project directory. **Known limitation:** git tagging requires at least one commit — if the project has just been initialized (`git init` only), the UI should show a warning instead of attempting the tag.
3. Server updates `.vibezzz/ideas.yaml`: sets `status: implemented`, `implemented_at`, `git_tag`
4. UI shows git tag badge on the idea card

---

## Deployment

Single `systemd` service:

```ini
[Service]
ExecStart=bun start
WorkingDirectory=/path/to/vibebox-brain
EnvironmentFile=/path/to/vibebox-brain/.env
```

Bound to the Tailscale interface IP. No public exposure in v1 — auth layer is out of scope for this iteration.

### `.env`

```
PORT=3000
BIND_HOST=100.x.x.x    # Tailscale IP in production; use 0.0.0.0 for local dev
PROJECTS_DIR=/home/user/projects
VIBEZZZ_REPO=/home/user/projects/vibezzz
DEFAULT_PROVIDER=claude        # claude | copilot
```

### NixOS

Not NixOS-specific, but easy to wrap: the `systemd` service definition maps directly to a NixOS `systemd.services` entry. A thin NixOS module can be added later.

---

## Non-Functional Requirements

- **Mobile-friendly:** all views usable on a phone browser over Tailscale
- **No auth in v1:** Tailscale network provides access control
- **Agent-readable:** all state files are plain YAML, no binary formats
- **Portable:** no NixOS-specific dependencies; runs anywhere Bun runs

---

## Out of Scope (v1)

- Authentication / login system
- Public internet exposure
- Real-time filesystem watching (use Resync instead)
- Synthesis result persistence
- Multi-user support
- Notifications / alerts
- vibebox-core, vibebox-deploy, vibebox-ui (separate specs)
