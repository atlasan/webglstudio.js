# WebGLStudio.js — Initial Audit & Assessment

- **Date:** 2026-11-24
- **Branch:** `audit/initial-assessment`, based on `master` @ `9a215de`
- **Scope:** repository layout, dependencies, how to run it, a security read of the server-side code, and a first health assessment. This is a first pass, not a full penetration test.

---

## 1. Repository state and alignment

| Remote | URL | Status |
|---|---|---|
| `origin` | github.com/atlasan/webglstudio.js (fork) | local `master` was in sync with it |
| `upstream` (added) | github.com/jagenjo/webglstudio.js (original) | 1 commit ahead of the fork: `9a215de` (2026-07-14) |

Local `master` was **fast-forwarded** to `upstream/master`. The only change is in the README: upstream now says
**"WEBGLSTUDIO HAS BEEN ABANDONED, IT MIGRATED TO ONEDIT.ORG"**. `origin/master` has **not** been pushed yet.

Before that, the last code commit was in July 2020. The project has had no active maintenance for about 6 years.

## 2. What the project is

WebGLStudio.js is an editor for 3D scenes that runs in the browser. It's built on the author's own libraries:

| Library | Role | Vendored at |
|---|---|---|
| LiteScene.js | scene graph / engine (components, materials, rendering) | `editor/js/extra/litescene.js` (1.6 MB) |
| LiteGL.js | WebGL wrapper (meshes, textures, shaders) | `editor/js/extra/litegl.js` |
| LiteGraph.js 0.4 | node-graph editor (behaviours, shaders, FX) | `editor/js/extra/litegraph.js` |
| LiteGUI.js | UI toolkit (panels, dialogs, menus) | `editor/js/extra/litegui.js` |
| LiteFileServer.js | client for the LiteFileSystem PHP backend | `editor/js/extra/litefileserver.js` |
| gl-matrix, CodeMirror 5.12.1, JSZip 3.x, pako 1.0.6, jscolor | third-party | `editor/js/extra/` |

### Layout

```
editor/            The app (static HTML + JS). Entry points: index.html, player.html, mobile.html
  config.json        backend paths (fileserver/src/, fileserver/files/, proxy)
  imports.json       ordered module list loaded at runtime by core.js (75 sync + 7 async)
  js/core.js         bootstrap: loads config → imports → initialises modules
  js/modules/        ~45 feature modules (editor, render, drive, coding, graph, undo, collaborate…)
  js/tools/          viewport tools (move/rotate/scale/select/camera…)
  js/widgets/        UI widgets (inspector, timeline, scene tree, coding pad…)
  js/extra/          vendored libraries (~139k lines)
plugins/           optional editor plugins (list.json + scripts/)
serverapps/        optional backend helpers: fbxconv (PHP + native binary), mitsuba (Node WS render server), project_deployer (PHP)
guides/            developer docs (architecture, components, plugins, file system…)
utils/             repack.sh, search.sh
```

The editor's own code is about **44.7k lines** of JS. The vendored libraries add about **139k lines**.
There's no build step, no package manager, no tests, no linter and no CI.

## 3. Dependencies and how to run it

- **No `package.json` at the root.** All browser dependencies are committed under `editor/js/extra/`, so nothing needs to be installed from npm for the editor.
- **Backend dependency: LiteFileSystem** (PHP + MySQL), needed for login, file storage and saving scenes.
  It was cloned (`--depth 1`, upstream `cab47f1`, 2022-02-11) into `editor/fileserver/`, which `editor/.gitignore` already ignores.
  Its `src/litefileserver.js` is identical to the vendored copy.
- **Not available on this machine:** `php`, `mysql`, `node`. So the backend and serverapps could not be run.
- `serverapps/mitsuba` has a `package-lock.json` but **no `package.json`**, and the lock file doesn't include `websocket`, which `main.js` requires. You can't do a clean `npm ci` for it as it stands.

### Smoke test (done)

`.claude/launch.json` → `python3 -m http.server 8765 --directory editor` (static only).
Result: the editor UI **boots and loads all modules**. Expected errors:
- `Cannot connect with server`: there's no PHP backend (POST → 501).
- The CORS fetch of `http://webglstudio.org/doc/litescene/data.json` (used for console autocomplete) fails because that external host is gone.

To run the full stack, you need Apache/nginx + PHP + MySQL. Then follow `INSTALL.md` and `editor/fileserver/INSTALL.md`.

## 4. Security findings

Severity is rated for a deployment that's exposed to the internet.

### Critical / High

| # | Location | Finding |
|---|---|---|
| S1 | `serverapps/project_deployer/deployer.php:17` | `explode($IGNORE_EXTENSIONS, ",")` has its **arguments swapped**, so the extension blocklist is never applied. `array_search(...) != false` also misses index 0. A deploy can then download `.php` files into a web-served folder. That's **remote code execution** for anyone who has the deploy key. |
| S2 | `deployer.php:166-185` | Path checks are weak. The `strpos(..., "..") != false` check misses `..` at position 0. Filenames in `files[]` and `scene` aren't checked at all, so `project_folder . "/" . $filename` can write outside the deploy folder (`../`). |
| S3 | `serverapps/fbxconv/fbxconv.php:24-35` | `?done=<name>` **deletes a file without any authentication**. It blocks only `..` and a leading `/`, so `?done=fbxconv.php` deletes the script itself (or any file in the working directory). Uploads are also unauthenticated and have no size limit. Cleanup is disabled (`if(0)`), so `temp/` grows without bound (a disk-filling DoS). |
| S4 | `editor/js/modules/sceneStorage.js:57` | `index.html?scene=<any URL>` loads a scene from any origin. Scenes can contain scripts that run with `new Function` / `eval` inside the editor's origin. Anyone who sends a link can then run JS **with the victim's LiteFileSystem session** (stored XSS by design). |
| S5 | `serverapps/mitsuba/main.js` | The WebSocket server **accepts any origin and has no auth**. Any client can upload files, unzip them (`unzip -o`) and start `mitsuba` processes. `JSON.parse` on incoming messages isn't wrapped in try/catch, so one bad message **crashes the server**. |

### Medium / Low

- `deployer.php` `action=report`: the token isn't validated (unlike `end`). The log is embedded in JSON with `addslashes`, which can produce invalid JSON. `Access-Control-Allow-Origin: *` is set on every response.
- `fbxconv.php` sends internal temp paths in the `X-debug` header. It also calls `join($out, "|")`, the old argument order, which is a **fatal error on PHP ≥ 8**.
- `editor/config.json` points to `@/proxy.php?url=`, which isn't in this repo. If a deployment provides an open proxy, that's an SSRF risk to check.
- About 88 `innerHTML` assignments in the editor code. Most render data that comes from the user or the scene (names, file listings), which is a DOM-XSS risk when scenes are shared.
- `eval` in `consoleWidget.js`, `generic.js` and `meshPainter.js` (`eval(this.settings.tex_format)`). These are intended developer features, but they inherit S4.
- Committed artefacts: `libfbxsdk.so` (10 MB proprietary Autodesk SDK, so check the licence before redistributing), `fbx-conv-lin64` binary, `mitsuba.gattaca.log`.
- Outdated vendored libs: CodeMirror 5.12.1 (2016), pako 1.0.6, mitsuba npm tree from 2017 (`got` 7, `decompress` 4.2.0, which has a known path-traversal CVE).
- Links over plain `http://` and dead `webglstudio.org` links in About, Intro, Coding help and the console docs.

## 5. Health assessment

| Area | Rating | Notes |
|---|---|---|
| Feature richness | ★★★★☆ | A full editor: materials, graphs, timeline, coding, collaboration, export, lightmaps |
| Architecture | ★★★☆☆ | Clear module system (`imports.json` + `CORE.registerModule`), but everything lives in globals and there are no ES modules |
| Maintenance | ★☆☆☆☆ | Abandoned upstream (moved to onedit.org); last code change in 2020 |
| Build / tooling | ★☆☆☆☆ | No package manager, bundler, tests, lint or CI |
| Security (server apps) | ★☆☆☆☆ | S1–S3, S5: don't expose serverapps as they are |
| Security (editor) | ★★☆☆☆ | Shared scenes execute code (S4). That's acceptable only on a single-user, trusted deployment |
| Docs | ★★★☆☆ | `guides/` are useful for developers. The INSTALL steps are dated |

## 6. Suggested next steps (in priority order)

1. **Decide the fork's direction:** keep maintaining WebGLStudio, or evaluate migrating to onedit.org as upstream did.
2. **Quick security fixes:** S1/S2 (fix `explode`, validate paths with `realpath`), S3 (require auth on `done`, re-enable cleanup, `implode` fix for PHP 8), S5 (origin allowlist, try/catch).
3. Restrict `?scene=` to same-origin or an allowlist, or ask the user to confirm before running scripts from a remote scene.
4. Add a root `package.json` with a static dev server, ESLint and a smoke test (e.g. Playwright loading `index.html`), plus CI.
5. Rebuild the `serverapps/mitsuba` manifest (`package.json` + `websocket`) and refresh its dependencies.
6. Write a Docker Compose setup (php-apache + mysql + LiteFileSystem) so the full stack can be reproduced locally.
7. Update the vendored Lite* libraries from their upstream repos, and update CodeMirror and pako.
