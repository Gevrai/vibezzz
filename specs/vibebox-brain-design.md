# vibebox Brain Design Spec

**Date:** 2026-03-14
**Status:** Revised

## Overview

vibebox is a self-hosted, Tailscale-accessible SvelteKit web app for capturing ideas, turning them into real projects, running coding agents on them, exposing previews, and publishing projects to the internet from the same machine.

The primary design goal is not generic project management. It is a fun, ergonomic personal async-builder loop:

1. Capture an idea from anywhere
2. Promote it to a project
3. Automatically start implementation on the server
4. Expose a preview URL when it is testable
5. Notify the user with a link
6. Optionally promote that preview into a stable public deployment
7. Iterate projects with more ideas and agent runs over time, all backed up in GitHub.

vibebox remains fully file-based (YAML + git) — no database. Humans and AI agents read and write the same project files. The app is single-user by design and optimized for personal projects rather than team workflows.

Public access is routed through Caddy. Cloudflare can sit in front either as wildcard DNS or a tunnel ingress, depending on host setup. The vibebox UI itself stays private behind Tailscale.

---

## Product Shape

vibebox has two distinct access modes:

- **Control plane:** the vibebox web UI, reachable over Tailscale only
- **Project plane:** preview and published project URLs, reachable publicly through Caddy + Cloudflare

The product should feel like a personal workshop, not an ops console. The happy path is:

`idea -> project -> agent run -> preview ready -> notification -> publish if worth keeping`

Deployment features matter, but they support that loop rather than define it.

---

## Scope

This spec covers three phases inside one SvelteKit app.

| Phase | Scope | Role in product |
|-------|-------|-----------------|
| 1 | Idea capture, project bootstrap, agent runs, live logs, preview URLs, notifications | Core joy loop |
| 2 | Stable public publish via container + routed subdomain | MVP completion |
| 3 | Lazy containers, route reconciliation polish, operational safety refinements | Optimization |
| 4 | Auth layer on top of Tailscale | Out of scope |

### Core product promise

If the user is away from their desk and has an idea, they should be able to capture it, promote it, let vibebox build it, and later receive a link when it is ready to test.

### MVP boundary

MVP includes:

- global inbox
- project promotion + bootstrap
- long-running agent runs with logs
- preview start/stop and preview URLs
- notification when a preview becomes ready
- one-click stable publish using a container image

MVP does **not** require lazy containers to be perfect. They are useful, but the preview/publish loop matters more than idle optimization.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | SvelteKit 5 + Svelte 5 | Lightweight, SSR built-in, good fit for a self-hosted control plane |
| Runtime | Bun | Fast startup, simple subprocess APIs, good ergonomics for YAML/file workflows |
| Adapter | `svelte-adapter-bun` | Bun-native deployment |
| Storage | YAML files + git repos | Agent-readable, inspectable, portable, easy to back up |
| Reverse proxy | Caddy | Dynamic host routing via admin API |
| Styling | TailwindCSS | Fast iteration and mobile-friendly layouts |
| Notifications | Generic webhook | Simple integration with ntfy, Pushover, Discord, Telegram bridges, etc. |

---

## File Layout

```text
~/projects/vibezzz/                 ← this repo (vibebox itself)
└── ideas.yaml                      ← global ideas inbox

~/projects/                         ← PROJECTS_DIR (configurable via .env)
└── <category>/
    └── <project>/
        ├── .git/
        └── .vibezzz/
            ├── ideas.yaml          ← project-scoped ideas
            ├── meta.yaml           ← project metadata + high-level stage
            ├── agents.yaml         ← agent run history
            ├── deploy.yaml         ← preview + publish configuration
            └── logs/
                └── <agent-id>.log  ← captured stdout/stderr for each run
```

All writes to YAML files must use atomic write semantics:

1. read current file
2. apply change in memory
3. write to temporary file in same directory
4. rename over original file

That is required because the UI server and agent processes may touch the same project state over time.

### `ideas.yaml` schema

Used both globally and inside each project.

```yaml
- id: 1
  content: "build a tiny multiplayer music queue"
  created_at: 2026-03-14T10:00:00Z
  status: raw              # raw | promoted | implemented
  project_path: null       # set in global ideas.yaml after promotion
  implemented_at: null
  git_tag: null
```

### `.vibezzz/meta.yaml` schema

```yaml
name: music-queue
category: js
origin: brain             # brain | external
created_at: 2026-03-14T10:00:00Z
idea_id: 1                # null for external projects
template: sveltekit       # optional starter/template used at bootstrap
project_stage: building   # bootstrapping | building | preview_ready | published | paused
last_ready_at: null
```

`project_stage` is a user-facing high-level status used on project cards and notifications. It is intentionally coarse and should stay easy to understand on mobile.

### `.vibezzz/agents.yaml` schema

```yaml
- id: 1
  provider: claude            # claude | copilot
  kind: implement             # bootstrap | implement | refine | custom
  summary: "Create MVP from promoted idea #3"
  started_at: 2026-03-14T10:00:00Z
  finished_at: null
  status: running             # running | done | failed | stopped
  pid: 12345
  process_started_at: 2026-03-14T10:00:00Z
  cwd: /home/user/projects/js/music-queue
  idea_id: 3
  log_path: .vibezzz/logs/1.log
  exit_code: null
  branch: main
  commit_sha: null
  result: building           # building | ready_for_test | blocked | failed
  preview_url: null
```

Agent runs are append-only history. Active runs are also tracked in memory by the Bun server for log streaming and stop actions.

**Startup reconciliation:** on vibebox startup, scan all `.vibezzz/agents.yaml` files for entries with `status: running`. A run is only considered still alive if:

- the PID exists
- the process start time matches `process_started_at`
- the process still belongs to the expected project working directory

Otherwise mark the run `failed` or `stopped` and record `finished_at`.

### `.vibezzz/deploy.yaml` schema

```yaml
preview:
  command: "bun run dev -- --host 0.0.0.0 --port 3001"
  port: 3001
  healthcheck_path: /
  pid: null
  process_started_at: null
  status: stopped          # stopped | starting | ready | failed
  subdomain: music-queue-preview
  url: null                # https://music-queue-preview.<DOMAIN>
  public: true
  last_ready_at: null

publish:
  state: down              # down | up | lazy
  subdomain: music-queue
  url: null                # https://music-queue.<DOMAIN>
  image: null
  container_name: vibebox-music-queue
  container_id: null
  container_port: 3001
  idle_timeout: 300
  last_request_at: null
  caddy_route_id: vibebox-music-queue

automation:
  auto_start_agent: true
  auto_start_preview: true
  auto_notify_on_ready: true
  auto_publish: false
```

`preview` is the fast feedback surface. `publish` is the durable shareable surface.

**Startup reconciliation:** on vibebox startup:

- clear stale preview process metadata if the process is gone or mismatched
- clear stale container metadata if `inspect` says the container no longer exists
- re-register any expected Caddy routes for previews or published projects that should be reachable

---

## AI Provider Abstraction

The provider abstraction must model a real long-running coding process, not a single request/response call.

Both CLIs are already authenticated on the host machine. vibebox never needs to store API keys itself.

```typescript
interface AgentRunHandle {
  pid: number
  startedAt: string
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stop(): Promise<void>
  wait(): Promise<{
    exitCode: number
    finishedAt: string
    commitSha?: string
    result: 'ready_for_test' | 'building' | 'blocked' | 'failed'
  }>
}

interface AIProvider {
  name: string
  startRun(input: {
    prompt: string
    cwd: string
    kind: 'bootstrap' | 'implement' | 'refine' | 'custom'
  }): Promise<AgentRunHandle>
}
```

### Provider behavior

- Providers must use agent-capable CLI modes, not one-shot `--print` style output.
- Prompt text must always be passed as a separate subprocess argument or via stdin, never interpolated into a shell command string.
- vibebox captures stdout/stderr into `.vibezzz/logs/<agent-id>.log` while also exposing live tail output in the UI.
- Default provider comes from `DEFAULT_PROVIDER`.
- The UI may allow per-run provider selection, but the common path should default intelligently rather than forcing extra clicks.

---

## Views

### `/` — Global Inbox

- Textarea + submit button for quick idea capture
- Mobile-friendly list of ideas, newest first
- Status badge on each idea
- `Promote to Project` action on raw ideas
- Shortcut/capture helper showing a simple API endpoint for phone automation
- Recently promoted ideas remain visible with a link to the project

### `/synthesis`

- Optional provider selector
- `Synthesize` button for ranked summaries of raw ideas
- Output is ephemeral and not persisted
- Useful for triage, but not part of the core async-builder loop

### `/projects`

- Collapsible category sections derived from `meta.yaml`
- `Resync` button to scan `PROJECTS_DIR`
- Each project card shows:
  - project name
  - origin badge
  - project stage badge
  - agent activity badge
  - preview status badge
  - publish status badge
  - preview and public URLs when available
- Move action per project
- Click through to `/projects/[...path]`

### `/projects/[...path]` — Project Detail

Three tabs:

**Ideas tab**
- Add project-scoped idea
- See idea history
- `Run Agent` from a selected idea
- `Mark Implemented` once a specific idea is shipped

**Runs tab**
- Running agent at the top with elapsed time, provider, stop button
- Live log stream for the active run
- History list below with summary, status, result, branch, commit SHA, and link to stored log
- `Start Run` form with provider + prompt
- `Promote to Preview` action when a run reports `ready_for_test`

**Access tab**

*Preview section*
- Preview command + port inputs saved to `deploy.yaml`
- Start/Stop preview process
- Preview healthcheck status
- Preview URL if public preview is enabled
- `Restart Preview` and `Open Preview` buttons

*Publish section*
- Image input
- Subdomain input
- State selector: `up | down | lazy`
- `Publish` / `Unpublish` button
- Stable public URL when published
- Explicit note that publish is for keeping/sharing something beyond the temporary preview

### `/monitor` — Global Monitor

- All currently running agents across all projects
- Active preview processes
- Recent completed runs
- Recent notification events
- Quick links to projects that became ready

---

## API / Automation Surfaces

These are first-class because the product is meant to be usable away from the desk.

### `POST /api/ideas`

Minimal endpoint for quick capture from phone shortcuts, shell aliases, or automations.

```json
{
  "content": "voice memo transcription or typed idea"
}
```

It appends a new raw idea to the global `ideas.yaml`.

### `POST /api/projects/:path/runs`

Starts an agent run for a project using the chosen provider and prompt.

### `POST /api/projects/:path/preview/start`

Starts or restarts the preview process, waits for readiness, and updates `deploy.yaml`.

### `POST /api/projects/:path/publish`

Applies the selected publish state (`up`, `down`, `lazy`) using the configured container runtime and Caddy route management.

---

## Key Flows

### Capture Idea

1. User submits an idea from the UI or `POST /api/ideas`
2. Server appends it to global `ideas.yaml` with `status: raw`
3. Idea appears immediately in the inbox

### Promote Idea to Project

1. User clicks `Promote`, chooses project name, category, and optional starter template
2. Server creates `$PROJECTS_DIR/<category>/<name>/`
3. Server runs `git init`
4. Server writes:
   - `.vibezzz/meta.yaml`
   - empty `.vibezzz/ideas.yaml`
   - empty `.vibezzz/agents.yaml`
   - starter `.vibezzz/deploy.yaml`
5. Server updates global `ideas.yaml` to `status: promoted`, with `project_path`
6. If `automation.auto_start_agent` is true, server starts a bootstrap/implementation agent immediately
7. UI navigates to the new project page

### Start Agent Run

1. User starts a run manually, or a promotion triggers one automatically
2. vibebox invokes the provider in the project directory
3. vibebox appends a `running` entry to `.vibezzz/agents.yaml`
4. vibebox streams stdout/stderr to:
   - `.vibezzz/logs/<agent-id>.log`
   - the live Runs tab
5. On exit, vibebox records:
   - `status`
   - `finished_at`
   - `exit_code`
   - `commit_sha` if available
   - high-level `result`

### Preview Ready

1. A run finishes with `result: ready_for_test`, or the user starts preview manually
2. If `automation.auto_start_preview` is true, vibebox starts the configured preview command
3. vibebox waits for the preview healthcheck to pass
4. vibebox updates:
   - `preview.status: ready`
   - `preview.url`
   - `meta.project_stage: preview_ready`
   - `meta.last_ready_at`
5. If `automation.auto_notify_on_ready` is true, vibebox sends a notification containing the project name and preview URL

### Publish Project

**State: `up`**
1. Ensure the project has an image configured
2. Start container with the configured runtime
3. Register a stable Caddy route for `<subdomain>.<DOMAIN>`
4. Update `publish.state: up`, `container_id`, and `url`
5. Set `meta.project_stage: published`

**State: `lazy`**
1. Register a stable wake route in Caddy pointing back to vibebox
2. Keep the container stopped until the first request
3. On first request:
   - start container
   - wait for readiness
   - proxy through
   - update `last_request_at`
4. Background cleanup stops idle containers after `idle_timeout`

**State: `down`**
1. Stop container if running
2. Remove public route
3. Clear `container_id`
4. Leave preview flow untouched

### Resync Project Tree

1. User clicks `Resync`
2. Server scans `PROJECTS_DIR` for git repositories
3. Missing `.vibezzz/meta.yaml` files are created with `origin: external`
4. UI refreshes the project tree

### Mark Idea as Implemented

1. User clicks `Mark Implemented`
2. Server creates git tag `idea/<id>-<slug>` if the repo already has a commit
3. Server updates `.vibezzz/ideas.yaml` with `status: implemented`, `implemented_at`, and `git_tag`

### Notify User

1. vibebox generates a short event payload when:
   - a preview becomes ready
   - a publish succeeds
   - a run fails after automatic promotion/bootstrap
2. vibebox POSTs to the configured webhook
3. Event includes project name, summary text, and URL when available

---

## Caddy + Cloudflare Setup

vibebox always uses Caddy as the local router. Cloudflare is the ingress layer in front of it.

Two supported exposure modes:

### Mode: `direct`

- wildcard DNS points at the server IP
- Caddy terminates TLS directly
- vibebox manages routes through the Caddy admin API

### Mode: `tunnel`

- `cloudflared` exposes `*.DOMAIN` and `vibebox.DOMAIN`
- Cloudflare forwards traffic to local Caddy
- Caddy still does host-based routing to previews and published apps

This keeps the app compatible with the user's current Cloudflare tunnel setup while preserving a simple internal routing model.

### Required Caddy capabilities

- admin API enabled on localhost
- deterministic route IDs, not array-index deletes
- static route for `vibebox.<DOMAIN>`
- dynamic routes for:
  - preview subdomains
  - published project subdomains
  - lazy wake handlers

---

## Container Runtime

Published apps use a container runtime controlled by `CONTAINER_RUNTIME`.

- default: `docker`
- alternative: `podman`
- vibebox shells out to the runtime CLI rather than depending on a daemon SDK

**Important distinction:**

- vibebox **does** manage running/stopping published containers
- vibebox does **not** need to build images automatically for MVP
- however, the product should make previews easy even before a container image exists

That means previews can be process-based, while stable publish remains image-based.

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

```text
PORT=3000
BIND_HOST=100.x.x.x
PROJECTS_DIR=/home/user/projects
VIBEZZZ_REPO=/home/user/projects/vibezzz
DEFAULT_PROVIDER=claude
DOMAIN=yourdomain.com
CADDY_ADMIN_URL=http://localhost:2019
CONTAINER_RUNTIME=docker
EXPOSE_MODE=tunnel                # tunnel | direct
LAZY_IDLE_TIMEOUT=300
NOTIFY_WEBHOOK_URL=
NOTIFY_WEBHOOK_BEARER_TOKEN=
```

### Notification behavior

If `NOTIFY_WEBHOOK_URL` is set, vibebox sends JSON POST requests for important events. No provider-specific integration is required in the core app.

### NixOS

Still not NixOS-specific. A thin module can wrap the env vars and service definition later.

---

## Operational Safety

This is a personal tool, so safety should be pragmatic rather than heavy-handed.

Keep:

- Tailscale-only access for vibebox UI
- no custom auth system
- plain YAML state
- direct CLI use for providers and container runtime

Add:

- atomic YAML writes
- deterministic Caddy route IDs
- preview/container reconciliation on startup
- no shell interpolation for prompts or project paths
- sensible container defaults when publishing

Non-goals for now:

- hard multi-tenant isolation
- sandboxed browser terminals
- enterprise secrets management

---

## Non-Functional Requirements

- **Mobile-friendly:** all major flows usable on a phone browser over Tailscale
- **Single-user:** optimized for one person and their projects
- **Agent-readable:** all durable state lives in plain YAML and git
- **Observable:** active runs must expose live logs and durable log files
- **Portable:** runs anywhere Bun runs
- **Restart-safe:** stale process/container/route metadata is reconciled on startup
- **Fun-first:** the default workflow minimizes clicks and prioritizes fast feedback

---

## Out of Scope

- Authentication/login system beyond Tailscale
- Multi-user collaboration
- Real-time filesystem watching
- Persistent synthesis history
- Browser SSH terminal
- Automatic image build pipelines beyond simple future hooks
