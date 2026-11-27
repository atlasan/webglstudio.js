# Server apps hardening

Fixes for findings S1, S2, S3 and S5 of the initial audit (`docs/audit/ASSESSMENT.md` on branch `audit/initial-assessment`).
S4 (remote scenes running scripts in the editor) is in the editor, not the server apps, and is tracked separately.

## `serverapps/project_deployer/deployer.php` (S1, S2)

| Before | After |
|---|---|
| `explode($IGNORE_EXTENSIONS, ",")` had its arguments swapped, so the blocklist was never applied | Fixed. A built-in list (`php`, `phtml`, `phar`, `cgi`, `.htaccess`…) is always blocked, plus whatever `config.php` adds |
| Only the last extension was checked | Every dot-part is checked, so `shell.php.png` is rejected |
| `project_folder`'s `..` check missed position 0. `files[]` and `scene` weren't checked | Every path is normalised and must be relative, with no `..`, no dot-files, no backslashes and no scheme |
| curl followed any protocol (`file://`, `gopher://`) | Only `http`/`https`, for the request and for redirects. `base_path` must be http(s) |
| `action=report` didn't validate the token and built JSON by hand | Token must be alphanumeric. Output uses `json_encode` |
| Key compared with `!==` | `hash_equals` |
| An empty `$BASE_DEPLOY_FOLDER` deployed to `/` | Refused |
| The info JSON stayed in the (public) deploy folder | Deleted after it's read |
| Shell command built from raw paths | `escapeshellarg` |

**Compatibility:** an existing `config.php` keeps working. A deploy can now fail only if it contains unsafe paths or files with blocked extensions, and those files are skipped and logged.

## `serverapps/fbxconv/fbxconv.php` (S3)

- `?done=` only accepts names that this script generated (`temp/phpXXXX`). It can no longer delete arbitrary files.
- Conversions older than 1 hour are deleted on every request (`$TEMP_MAX_AGE`), so `temp/` no longer grows without bound.
- Uploads must be POST, use `move_uploaded_file`, and are limited by `$MAX_UPLOAD_SIZE` (100 MB).
- Media embedded in the FBX is extracted into the public `temp/` folder. Anything that isn't a plain image (e.g. an embedded `.php`) is now deleted.
- PHP 8 fix: `join($out, "|")` → `implode("|", $out)`. The command argument is escaped, and the `X-debug` header that leaked the internal path is gone.

**Compatibility:** the response format the `plugins/scripts/fbxconv.js` plugin expects is unchanged.

## `serverapps/mitsuba` (S5)

- **New, required:** set the editor origins allowed to connect:
  ```bash
  MITSUBA_ALLOWED_ORIGINS="https://my-editor-host.com" node main.js -p 9003
  ```
  You can also use `-o <origins>`, or `*` to allow any origin (not recommended). Without it, every WebSocket connection is rejected.
- `MITSUBA_MAX_CLIENTS` (default 4) limits concurrent renders.
- `MITSUBA_DOWNLOAD_HOSTS` (optional): extra hosts the server may download textures from. By default it only downloads from the host of the editor that connected, which stops SSRF.
- Malformed messages are rejected instead of crashing the server.
- Every client gets its own random folder. On disconnect, the client's processes are killed and its folder is deleted. Before, every client shared `temp/user_test`, and nothing was cleaned up.
- File names in `rename`, `startbin`, `scene` and `download` are validated, so no traversal is possible.
- The HTTP status endpoint returns only the number of clients, not their IPs.
- Fixed the download bookkeeping: a failed download no longer leaves the render waiting forever, and an unhandled stream error no longer crashes the server. Fixed `https` downloads, and `send()` of binary data, which referenced an undefined variable.
- Added `package.json` (dependency `websocket`). The stale 2017 `package-lock.json` (for the unused `download` package, which has known CVEs) was replaced. `npm audit`: 0 vulnerabilities.

## Verification

- `mitsuba`: `node --check` passes, and 18 automated checks passed against a running server (Node 22). They covered origin rejection, max clients, malformed JSON, path traversal in `rename`/`startbin`/`download`, `file://` and foreign-host downloads, a same-origin nested download, per-client folders, folder cleanup, and the server staying up.
- PHP files: **not executed**, because no PHP runtime was available. They were reviewed by hand. They need a test on a PHP 7.2+/8.x server before deploying.
