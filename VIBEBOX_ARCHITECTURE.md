# Vibebox Brain Publish Architecture Map
## After Commit 86290a9: Wake Route Restoration & Lazy Entry Deferral

### ARCHITECTURE OVERVIEW

**Publish State Machine:**
```
down → up    : start container, register direct route to container
down → lazy  : register wake route to vibebox app, container starts on demand
up   → down  : stop container, remove direct route
lazy → down  : remove wake route, stop container if running
up   → lazy  : stop container, register wake route
lazy → up    : start container, register direct route [← KEY TRANSITION]
```

**Lazy Wake Semantics:**
- Caddy route points to vibebox's own port (config.port)
- hooks.server.ts intercepts requests matching lazy hostname
- wakeAndProxy() starts container on demand, waits for health, proxies through
- Background idle timer stops containers after idle_timeout seconds

---

## 1. CHANGING PUBLISH SETTINGS (Especially lazy→up and rollback)

### Primary Function: `updatePublishSettings()`
**File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/lib/server/publish.ts` (lines 316-534)

**Signature:** 
```typescript
export async function updatePublishSettings(
    vibezzzDir: string,
    projectName: string,
    settings: PublishSettings
): Promise<DeployConfig>
```

**Key Behaviors:**

1. **Subdomain Change (lines 350-517):**
   - Validates subdomain uniqueness via `isSubdomainClaimedByOther()` (lines 352-354)
   - Defers destructive side effects (container stop) until AFTER persist (lines 361-379)
   - If state was 'up': transitions to 'down' and clears container_id/host_port
   - If state was 'lazy': prepares lazy re-registration with new subdomain (lines 386-406)
   - Persists before live side-effects (line 435)
   - **Deferred rollback paths (lines 491-517):**
     - Restores old subdomain and container_name if Caddy route upsert fails
     - Re-registers old Caddy route via `upsertRoute()` (line 503) [MANDATORY]
     - Re-enables old lazy registry entry if saved (lines 509-511)
     - Throws error after rollback complete (line 514)

2. **Image/Port Changes on Lazy Entry (lines 413-471):**
   - Disables lazy entry BEFORE persist so in-flight wakeAndProxy() aborts (line 425)
   - Clears container_id/host_port in config (lines 426-427)
   - Persist happens (line 435)
   - Deferred: stops running container (lines 452-455)
   - **Restores wake route via `upsertRoute()` to vibebox port** (line 466) [MANDATORY after image/port change]

3. **Lazy Registry Sync (lines 519-530):**
   - After successful persist, syncs updated settings to in-memory lazy entry
   - Re-enables entry if it was disabled (line 529)

**Rollback Paths:**
1. Persist failure: re-enables disabled lazy entry (lines 437-440)
2. Caddy route failure during subdomain change: full rollback (lines 491-514)
3. All three paths restore wake route via `upsertRoute(caddy_route_id, host, config.port)`

---

## 2. LAZY REGISTRY ENTRY / DISABLED-BUT-PRESENT SEMANTICS

### Registry Structure
**File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/lib/server/publish.ts`

**LazyEntry Interface (lines 76-89):**
```typescript
interface LazyEntry {
    vibezzzDir: string;
    projectPath: string;
    containerName: string;
    containerPort: number;
    hostPort: number | null;
    image: string;
    idleTimeout: number;
    lastRequestAt: number;
    starting: boolean;
    startPromise: Promise<number | null> | null;
    disabled: boolean;  // ← CRITICAL FLAG
}
```

**In-Memory Registry:**
- `lazyRegistry: Map<string, LazyEntry>` (line 92)
- Maps subdomain → lazy entry for O(1) lookup during request handling

### Key Functions for Registry Management

1. **`registerLazy(subdomain, entry)` (lines 853-856):**
   - Adds or updates entry in lazyRegistry
   - Ensures idle timer is running via `ensureIdleTimer()`
   
2. **`isLazyHost(hostname)` (lines 861-866):**
   - Fast domain check first
   - Returns `lazyRegistry.has(subdomain)` for hostname match
   - Used by hooks.server.ts to intercept requests
   - **CRITICAL: Works even if entry.disabled = true** (doesn't check disabled flag)
   
3. **`getLazyRegistry()` (lines 160-162):**
   - Returns read-only view of lazyRegistry
   - Exposed to tests and monitoring

### "Disabled-But-Present" Semantics (Commit 86290a9)

**BEFORE 86290a9:** Lazy entry was deleted immediately when transitioning away
**AFTER 86290a9:** Lazy entry stays in registry but marked `disabled: true`

**Why This Matters:**
- `isLazyHost(hostname)` returns true → Caddy routes request to vibebox
- `wakeAndProxy()` checks `entry.disabled` and returns null if true (line 879)
- Result: requests get 503 from vibebox instead of falling through to main app
- Prevents undefined behavior during state transitions

**Where disabled Flag is Used:**
- Line 579-583: Set to true at start of lazy→up transition
- Line 595, 614, 631: Set back to false in rollback paths  
- Line 638-640: Entry DELETED after direct route installed (first success point)
- Line 720: Set to true when transitioning to 'down'
- Line 737: Set back to false on persist failure

---

## 3. WAKE ROUTE INSTALL/REMOVE/RESTORE

### Primary Functions

1. **`upsertRoute(routeId, host, port)` (lines 60-95 in caddy.ts)**
   **File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/lib/server/caddy.ts`
   
   ```typescript
   export async function upsertRoute(
       routeId: string,
       host: string,
       port: number
   ): Promise<boolean>
   ```
   
   **Implementation:**
   - Creates Caddy route: `host` → reverse-proxy to `localhost:port`
   - Tries PATCH first (update existing), falls back to POST (create new)
   - Returns boolean: true on success, false on failure
   - Graceful degradation: logs warning, returns false (doesn't crash)

2. **`removeRoute(routeId)` (lines 100-105 in caddy.ts)**
   - Removes route by @id
   - Treats 404 as success (already gone)

### Wake Route Management in State Transitions

**Transition: down → lazy (lines 652-714)**
- Container state: 'down' → 'lazy'
- Persist happens first (line 675)
- Caddy route installed: `upsertRoute(caddy_route_id, host, config.port)` (line 684)
- On route failure: revert persist, throw error (lines 685-690)
- Lazy registry populated (line 693)
- **On failure:** no wake route exists, hostname unreachable

**Transition: lazy → down (lines 716-765)**
- Disable lazy entry first (line 720)
- Persist happens (lines 734-739)
- Route removed: `removeRoute(caddy_route_id)` (line 748)
- Route removal logged as warning only (line 749-750)
- Lazy registry entry deleted (line 752)

**Transition: lazy → up (lines 568-650) [COMMIT 86290a9 FIX]**
- Disable lazy entry (line 583) but DON'T DELETE YET (line 579-583 comment)
- Release old host port (line 588)
- Allocate new host port (line 590)
- Start container (line 591)
- On container start failure: restore wake route (line 597) [RESTORE #1]
- Persist (lines 608-618)
- On persist failure: restore wake route (line 616) [RESTORE #2]
- Install direct route: `upsertRoute(caddy_route_id, host, hostPort)` (line 621)
- On direct route failure: restore wake route (line 633) [RESTORE #3]
- **AFTER direct route succeeds: DELETE lazy entry** (lines 638-640)

**COMMIT 86290a9 Changes:**
Lines 576-640 in git diff:
- REMOVED: `lazyRegistry.delete(pub.subdomain)` at line 581 (old version)
- ADDED: "Disable (but don't delete)" comment (lines 579-581)
- REMOVED: `registerLazy(pub.subdomain, savedLazyEntry)` from rollback paths
- ADDED: `await upsertRoute(pub.caddy_route_id, host, config.port)` in all 3 rollback paths
- ADDED: Deferred deletion after direct route succeeds (lines 638-640)

### Wake Route Restoration During Image/Port Change
**Lines 451-471 in updatePublishSettings():**
- After stopping stale container
- **Mandatory:** restore wake route via `upsertRoute(caddy_route_id, host, config.port)` (line 466)
- Failure throws error: "hostname unreachable" (line 468)
- Ensures hostname doesn't point at dead upstream

### Idle Container Shutdown (lines 1046-1107)
**Function:** `checkIdleContainers()`
- Runs every 60 seconds (line 1035)
- For each lazy entry past idle timeout:
  - Stops container
  - Releases host port
  - **Restores wake route:** `upsertRoute(caddy_route_id, host, config.port)` (line 1097)
  - Updates persist state (lines 1102-1104)
  - Logs error if route restore fails (lines 1098-1100) [CRITICAL/MANDATORY]

---

## 4. DIRECT ROUTE INSTALLATION

### Primary Flow: lazy → up (lines 568-650)

**Step 1: Disable Lazy Entry (lines 579-583)**
```typescript
const savedLazyEntry = lazyRegistry.get(pub.subdomain) ?? null;
if (savedLazyEntry) savedLazyEntry.disabled = true;
// NOTE: lazyRegistry.delete() was removed in 86290a9
```

**Step 2: Allocate Host Port & Start Container (lines 587-603)**
```typescript
const hostPort = await allocateHostPort();  // Returns port in range 40000-49999
const containerId = await startContainer(
    pub.container_name, 
    pub.image, 
    pub.container_port,  // Container's internal port
    hostPort               // Dynamic host port
);
```

**Step 3: Persist (lines 608-618)**
- Updates: state='up', container_id, host_port, url
- On failure: cleanup + re-enable lazy entry + restore wake route

**Step 4: Install Direct Route (lines 621-636)**
```typescript
const routeOk = await upsertRoute(pub.caddy_route_id, host, hostPort);
// Now Caddy routes host → localhost:hostPort (direct to container)
```
- On failure: stop container, release port, re-enable lazy entry, restore wake route, re-persist, throw error

**Step 5: Delete Lazy Entry (lines 638-640)**
```typescript
if (savedLazyEntry) {
    lazyRegistry.delete(pub.subdomain);  // Only after route succeeds
}
```

### Direct Route Management

**Route ID Format:** `vibebox-{subdomain}` (lines 223, 229, 382-383)

**Route Structure (caddy.ts, lines 65-75):**
```typescript
const route: CaddyRoute = {
    '@id': routeId,
    match: [{ host: [host] }],
    handle: [{
        handler: 'reverse_proxy',
        upstreams: [{ dial: `localhost:${port}` }]
    }],
    terminal: true
};
```

**Reconciliation on Startup (lines 786-806)**
- For 'up' state: re-registers route pointing to host_port (or container_port if legacy)
- Tracks host port so it won't be re-allocated

---

## 5. REQUEST ROUTING / REGISTRY BEHAVIOR

### Request Interception Flow (hooks.server.ts)

**File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/hooks.server.ts` (lines 24-52)

**Handle Function Sequence:**
1. Extract hostname from request header (lines 25-28)
2. Await `reconciliationReady()` (line 32) - gate prevents races with startup
3. Check `isLazyHost(hostname)` (line 33)
4. If lazy: call `wakeAndProxy(hostname)` (line 34)
5. If port returned: redirect via 307 to same URL (lines 35-45)
   - 307 preserves method/body
   - Redirects through Caddy's reverse proxy (WebSocket-safe)
6. If null: return 503 "Service unavailable — container failed to start" (lines 46-48)
7. Otherwise: resolve normally (line 52)

### wakeAndProxy() Function (lines 873-1018)

**Entry Check (lines 878-879):**
```typescript
const entry = lazyRegistry.get(subdomain);
if (!entry || entry.disabled) return null;  // Disabled entries return null = 503
```

**Update Last Request Timestamp (lines 881-885):**
```typescript
entry.lastRequestAt = Date.now();
persistLastRequest(entry).catch(() => {});  // Non-blocking
```

**Container Already Running Path (lines 888-897):**
- If container running and hostPort set:
  - Ensures Caddy route points to hostPort (may have been missed)
  - Returns port if route update succeeds, null otherwise

**Container Wake Path (lines 899-1017):**
1. Serialize concurrent wakes via startPromise (lines 900-902)
2. Allocate fresh host port (lines 912-915)
3. Start container with captured image/port (lines 917-927)
4. Wait for health check (lines 929-937)
5. Check for disable/settings-change during wake (lines 939-955)
6. Persist container_id + host_port atomically (lines 957-988)
7. Switch Caddy route to point directly to container (line 981)
8. On persist failure: cleanup + restore wake route (lines 990-1004)

**Settings Change Race Detection (lines 949-955):**
- Captures image/port at wake start
- Verifies before persisting
- If changed: abort, stop container, return null

---

## 6. TESTS EXERCISING THESE PATHS

**File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/lib/server/__tests__/publish.test.ts`

### Publish Settings Tests (lines 25-143)
- `creates default publish config when none exists`
- `updates image without changing state`
- `updates subdomain and cascades to container_name and caddy_route_id`

### State Transitions Tests (lines 161-427)
- `rejects publish up without image`
- `rejects publish lazy without image`
- `down transition does not mutate non-published project_stage`
- `down transition reverts published stage to building`
- `down transition preserves preview_ready when preview is still active`
- `down transition clears publish url and container_id`

### Lazy Registry Tests (lines 429-463)
- `isLazyHost returns false for non-matching domain`
- `isLazyHost returns false for empty lazy registry`
- `getLazyRegistry returns empty map initially`

### Reconciliation Tests (lines 465-591)
- `reconcilePublish skips projects without publish config`
- `reconcilePublish populates lazy registry for lazy projects`
- `reconcilePublish marks stale up container as down`

### Notification Tests (lines 593-673)
- `lazy transition sends publish_succeeded notification`

### Startup Reconciliation Tests (lines 676-809)
- `reconcileOnStartup reconciles publish state for projects`
- `reconcileOnStartup populates lazy registry for lazy projects`

### Subdomain Change Tests (lines 812-1003)
- `changing subdomain while lazy re-registers lazy routing with new subdomain`
- `changing subdomain while up resets state to down and clears container_id`
- `changing subdomain while down does not reset state`
- `setting same subdomain is a no-op`

### Lazy Reconciliation Stale Metadata Tests (lines 1005-1135)
- `reconcilePublish clears stale container_id for lazy projects`
- `reconcilePublish preserves persisted last_request_at for lazy projects`
- `reconcilePublish uses Date.now() when no last_request_at is persisted`

### Lazy Wake/Proxy Path Tests (lines 1137-1306)
- `wakeAndProxy returns null for non-lazy hostname`
- `wakeAndProxy returns null for hostname on wrong domain`
- `wakeAndProxy updates lastRequestAt on each call`
- `isLazyHost matches after reconcilePublish populates registry`
- `checkIdleContainers respects persisted lastRequestAt across restart`

---

## 7. KEY LOCKING MECHANISMS

### Serialization Primitives

**File:** `/home/gejo/projects/vibezzz/.worktrees/vibebox-brain/src/lib/server/deploy-lock.ts`

1. **`withDeployLock<T>(vibezzzDir, fn)` (line 10)**
   - Per-project lock on deploy.yaml modifications
   - Ensures no concurrent updates to the same project's state

2. **`withSubdomainClaimLock<T>(fn)` (line 37)**
   - Global lock for subdomain uniqueness validation
   - Prevents race where two projects claim same subdomain

3. **`portAllocationQueue` (line 125 in publish.ts)**
   - Serializes host port allocation across concurrent lazy wakes
   - Ensures no two containers get same host port

### Concurrency Safeguards in wakeAndProxy()
- `entry.startPromise`: serializes concurrent wakes for same subdomain
- `entry.starting`: prevents multiple concurrent wake attempts
- All state checks happen inside `withDeployLock()` (lines 962-988)
  - Revalidates state, identity, and settings before persisting
  - Prevents stale metadata from being persisted after concurrent change

---

## 8. SUMMARY: ARCHITECTURE HIGHLIGHTS

### The Lazy→Up Transition (Commit 86290a9)

**Key Innovation:** Disabled-but-present semantics

**Before 86290a9:**
- Deleted lazy entry immediately
- Falling requests would hit main app (incorrect)
- Rollback paths called registerLazy() (complex)

**After 86290a9:**
- Disable entry, keep in registry
- Falling requests still see lazy host, get 503 (correct)
- Rollback paths just restore wake route (simpler)
- Only delete entry after direct route succeeds (safe)

### Critical Invariants

1. **Wake routes must always be restorable** (3x in lazy→up rollback, idleTimer, image/port change)
2. **Subdomain uniqueness is critical** (global lock guards all changes)
3. **Persist before destructive runtime changes** (prevents orphaned containers)
4. **Registry disabled flag gates request handling** (503 not main app)
5. **Route installation must succeed** (failure throws, triggers full rollback)

### Files & Functions Quick Reference

| Purpose | File | Function | Lines |
|---------|------|----------|-------|
| Settings changes | publish.ts | updatePublishSettings() | 316-534 |
| State transitions | publish.ts | applyPublishState() | 538-770 |
| Startup reconciliation | publish.ts | reconcilePublish() | 776-849 |
| Lazy wake/proxy | publish.ts | wakeAndProxy() | 873-1018 |
| Idle cleanup | publish.ts | checkIdleContainers() | 1046-1107 |
| Route operations | caddy.ts | upsertRoute() / removeRoute() | 60-105 |
| Request interception | hooks.server.ts | handle: Handle | 24-52 |
| Registry check | publish.ts | isLazyHost() | 861-866 |
| Registry management | publish.ts | registerLazy() | 853-856 |
| Locking | deploy-lock.ts | withDeployLock / withSubdomainClaimLock | 10, 37 |
