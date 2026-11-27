# LiteFileSystem is off by default

LiteFileSystem (login, accounts, remote file storage) is powerful, but it's also the riskiest part of a public deployment:
- it's multi-user,
- it serves user files from the editor's origin,
- it keeps its session token in `localStorage`.

See `remote-scene-trust.md` for why that combination is dangerous.

From now on, the editor **does not use it unless the installation explicitly turns it on.**

## The switch

`editor/config.json`:

```json
"fileserver_enabled": false,
```

| Value | Behaviour |
|---|---|
| `false` (default), or missing | **Offline mode.** The editor never contacts `fileserver/`: no login request, no session check, no "Cannot connect with server" alert. The menu bar shows *offline mode*. Login prompts explain how to enable it. Scenes can still be saved locally and exported. |
| `true` | Original behaviour: login, accounts, server storage. |

This setting belongs to the installation, not the user. The *Drive Service URL* user preferences can't turn the file server on; with the switch off, the preferences panel says those settings have no effect.

> The switch controls the **editor**. If the `fileserver/` PHP backend is installed, it still answers HTTP requests. To shut it down completely, don't install it, or block it in the web server (see below).

## Turning it on safely (LAN / restricted)

Recommended setup when you need it:

1. Set `"fileserver_enabled": true` in `editor/config.json`.
2. Limit who can reach the editor and the file server, e.g. Apache 2.4 in the editor folder:
   ```apache
   <Directory "/var/www/webglstudio">
       Require ip 127.0.0.1 192.168.0.0/16 10.0.0.0/8
   </Directory>
   ```
   nginx:
   ```nginx
   location / {
       allow 192.168.0.0/16;
       allow 10.0.0.0/8;
       deny all;
   }
   ```
3. Outside a LAN, put it behind HTTPS **and** authentication: a VPN, or a reverse proxy with basic/SSO auth.
4. Only give accounts to people you trust. Any user's scene can run code in another user's session (see the "Remaining risk" section of `remote-scene-trust.md`).

## Verified in the browser (static server, no PHP)

- `false`: 0 requests to `fileserver/`, no alert, *offline mode* shown, and the login prompt shows the explanation.
- `true`: the editor requests `fileserver/src/server.php` as before. With no backend running, the usual "Cannot connect with server" alert appears.
