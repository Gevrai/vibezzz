# vibebox Design Spec

**Date:** 2026-03-14
**Status:** Approved

## Overview

vibebox is a self-hosted, Tailscale-accessible SvelteKit web app for capturing ideas, managing development projects, monitoring AI agents, and serving projects live on the internet. It is fully file-based (YAML + git) — no database. Both humans and AI agents read and write the same files.

Accessible from any device on Tailscale (phone, laptop, etc.). Projects live on the host machine under a configurable `PROJECTS_DIR`. Public internet exposure uses wildcard DNS + Caddy dynamic routing, managed entirely from the vibebox UI.

---

## Scope

vibebox is a single SvelteKit app built in three phases, all covered by this spec. Auth is explicitly out of scope — Tailscale provides access control.

| Phase | Scope | Status |
|-------|-------|--------|
| 1 | Ideas inbox, synthesis, project tree | This spec |
| 2 | Agent monitoring — running Claude/Copilot processes per project | This spec |
| 3 | Live/deploy — port exposure, domain routing via Caddy | This spec |
| 4 | Auth layer on top of Tailscale | Out of scope |

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | SvelteKit 5 + Svelte 5 | Lightweight, SSR built-in, excellent for self-hosted tools |
| Runtime | Bun | Fast startup, built-in YAML support, clean `Bun.spawn()` API |
| Adapter | `svelte-adapter-bun` | Bun-native SvelteKit deployment |
| Storage | YAML files | File-based, git-tracked, human and agent readable — no database |
| Reverse proxy | Caddy | Dynamic vhost config via admin API, automatic HTTPS |
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
            ├── meta.yaml     ← project metadata
            ├── agents.yaml   ← agent run history
            └── deploy.yaml   ← deploy configuration
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

### .vibezzz/agents.yaml schema

```yaml
- id: 1
  provider: claude       # claude | copilot
  summary: "implement auth from idea #3"
  started_at: 2026-03-14T10:00:00Z
  finished_at: 2026-03-14T10:05:00Z
  status: done           # running | done | failed
  pid: 12345             # OS process ID; null when finished
  idea_id: 3             # nullable — which idea triggered this agent run
```

Active agent processes are also tracked in-memory by the Bun server (keyed by PID) for real-time status. On process exit the server writes the result back to `agents.yaml`.

### .vibezzz/deploy.yaml schema

```yaml
port: 3001
subdomain: my-app        # defaults to project name; used as <subdomain>.<DOMAIN>
live: false              # whether currently routed publicly via Caddy
start_command: "bun run dev"
process_pid: null        # PID of running dev server; null when stopped
```

---

## AI Provider Abstraction

A pluggable `AIProvider` interface. Both CLIs are already authenticated on the host machine — no API keys needed.

```typescript
interface AIProvider {
  name: string
  run(prompt: string, cwd?: string): Promise<string>
}
```

Implementations:
- `ClaudeProvider` — spawns `claude --print "<prompt>"` — prompt passed as a separate argument to `Bun.spawn()`, never interpolated into a shell string (prevents injection)
- `CopilotProvider` — spawns `copilot "<prompt>"` — same safe spawn approach

Provider is selectable per-action in the UI. Adding a new provider = one new class. Default set by `DEFAULT_PROVIDER` env var.

---

## Views

### `/` — Global Inbox

- Textarea + submit button to add a new idea
- List of all ideas sorted by `created_at` descending
- Each idea card: content, timestamp, status badge
- "Promote to Project" button on raw ideas
- Promoted ideas shown muted with project link, not removed

### `/synthesis`

- Provider selector (Claude / Copilot)
- "Synthesize" button — on-demand AI synthesis of all raw ideas
- Output: AI-generated ranked summary, not persisted — regenerate any time

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

- Collapsible category sections derived from `meta.yaml`
- "Resync" button — rescans `PROJECTS_DIR`
- Each project card: name, origin badge (brain/external), idea count, agent status dot (green if any agent running), LIVE badge if `deploy.yaml` live=true
- Move button per project: select/type new category
- Click → `/projects/[...path]`

### `/projects/[...path]` — Project Detail

Three tabs:

**Ideas tab**
- Add idea form → writes to `.vibezzz/ideas.yaml`
- List of ideas with status badges
- "Mark Implemented" button → creates git tag + updates `ideas.yaml`
- "Run Agent" button per idea → opens agent launcher with idea pre-filled

**Agents tab**
- Running agents listed first (with elapsed time, stop button)
- Agent history below (provider, summary, duration, status)
- "Start Agent" button: provider selector + freeform prompt input → spawns CLI process

**Deploy tab**
- Port input + start command input → saved to `deploy.yaml`
- Start/Stop dev server button → spawns/kills the `start_command` process
- Subdomain input (defaults to project name)
- "Go Live" toggle:
  - On: POST to Caddy admin API → adds `<subdomain>.<DOMAIN> → localhost:<port>` route → sets `live: true`
  - Off: DELETE from Caddy admin API → sets `live: false`
- Live URL shown when active: `https://<subdomain>.<DOMAIN>`

### `/monitor` — Global Agent Monitor

- All currently running agents across all projects
- Each row: project name (link), provider badge, summary, elapsed time, stop button
- Recent agent history (last 20 runs across all projects)

---

## Key Flows

### Promote Idea to Project

1. User clicks "Promote", enters project name and category
2. Server creates `$PROJECTS_DIR/<category>/<name>/`
3. Server runs `git init`
4. Server writes `.vibezzz/meta.yaml`, empty `.vibezzz/ideas.yaml`, empty `.vibezzz/agents.yaml`
5. Server spawns chosen CLI with scrum agent prompt + idea content in the new project directory; records agent run in `.vibezzz/agents.yaml`
6. Server updates global `ideas.yaml`: `status: promoted`, `project_path: <category>/<name>`
7. UI navigates to `/projects/<category>/<name>`

### Resync Project Tree

1. User clicks "Resync"
2. Server walks `PROJECTS_DIR` recursively, finds all directories containing `.git/`
3. For each found project: read `.vibezzz/meta.yaml` if present, else create it with `origin: external`, category inferred from path
4. Projects previously known but no longer on disk are flagged `missing` in the UI — transient UI-only state, not written to disk
5. UI refreshes tree

### Move Project

1. User selects new category
2. Server renames `$PROJECTS_DIR/<old>/<name>/` → `$PROJECTS_DIR/<new>/<name>/`
3. Server updates `category` in `.vibezzz/meta.yaml`
4. UI refreshes

### Mark Idea as Implemented

1. User clicks "Mark Implemented"
2. Server runs `git tag idea/<id>-<slug>` in project dir. **Known limitation:** requires at least one commit — UI shows a warning if repo has no commits yet.
3. Server updates `.vibezzz/ideas.yaml`: `status: implemented`, `implemented_at`, `git_tag`

### Start Agent

1. User selects provider + enters prompt (or promotes an idea)
2. Server spawns `claude --print "<prompt>"` or `copilot "<prompt>"` via `Bun.spawn()` in the project directory
3. Server appends entry to `.vibezzz/agents.yaml` with `status: running`, records PID in memory
4. On process exit: server updates `agents.yaml` entry with `status: done|failed`, `finished_at`
5. UI polls `/api/projects/[path]/agents` for live status

### Go Live (Caddy routing)

1. User sets port + subdomain in Deploy tab, toggles "Go Live"
2. Server PUTs a route to Caddy admin API (`$CADDY_ADMIN_URL/config/apps/http/servers/srv0/routes`):
   ```json
   {
     "match": [{ "host": ["<subdomain>.<DOMAIN>"] }],
     "handle": [{ "handler": "reverse_proxy", "upstreams": [{ "dial": "localhost:<port>" }] }]
   }
   ```
3. Server updates `deploy.yaml`: `live: true`
4. UI shows live URL badge

### Take Down (Caddy routing)

1. User toggles "Go Live" off
2. Server DELETEs the matching route from Caddy admin API
3. Server updates `deploy.yaml`: `live: false`

---

## Caddy Setup (one-time)

Caddy is configured once. vibebox manages routes dynamically at runtime via Caddy's admin API — no `nixos-rebuild switch` per project.

**Required Caddy config:**
- Admin API enabled on `localhost:2019`
- Wildcard TLS certificate for `*.<DOMAIN>` via ACME DNS challenge (Cloudflare API token)
- Static vhost for vibebox itself: `vibebox.<DOMAIN> → localhost:3000`

**Cloudflare DNS (one-time):**
- `*.yourdomain.com → <server IP>` (wildcard A record)
- `vibebox.yourdomain.com → <server IP>` (or covered by wildcard)

---

## Deployment

Single `systemd` service:

```ini
[Service]
ExecStart=bun start
WorkingDirectory=/path/to/vibebox
EnvironmentFile=/path/to/vibebox/.env
Restart=on-failure
```

### `.env`

```
PORT=3000
BIND_HOST=100.x.x.x        # Tailscale IP; use 0.0.0.0 for local dev
PROJECTS_DIR=/home/user/projects
VIBEZZZ_REPO=/home/user/projects/vibezzz
DEFAULT_PROVIDER=claude      # claude | copilot
DOMAIN=yourdomain.com
CADDY_ADMIN_URL=http://localhost:2019
```

### NixOS

Not NixOS-specific. The `systemd` service maps directly to `systemd.services` in NixOS config. A thin NixOS module wrapping the env vars and service definition can be added later.

---

## Non-Functional Requirements

- **Mobile-friendly:** all views usable on a phone browser over Tailscale
- **No auth:** Tailscale provides access control; no login system
- **Agent-readable:** all state files are plain YAML
- **Portable:** runs anywhere Bun runs; no NixOS-specific dependencies

---

## Out of Scope

- Authentication / login system
- Real-time filesystem watching (use Resync instead)
- Synthesis result persistence
- Multi-user support
- Notifications / alerts
- SSH terminal in the browser
