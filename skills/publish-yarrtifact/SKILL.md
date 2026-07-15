---
name: publish-yarrtifact
description: Publish a local folder or file as a shareable web page on yarrtifacts.com, or update an already published one so its link stays the same. Use when asked to publish, share, host, or upload an artifact, page, report, or HTML/Markdown bundle and return a link — or to push a new version of one published earlier. First-time use runs `login` to connect the account in the browser; also use when asked to log in, connect, or authenticate with yarrtifacts.
license: MIT
compatibility: Requires network access and Node.js 18+ (for the bundled script) or any HTTP client (curl works — see references/api.md).
metadata:
  author: yarrtifacts
  version: "0.4.0"
---

# Publish an artifact to yarrtifacts.com

Turn a local folder (multi-file HTML bundle, a single `.html`, a `.md` that renders to a styled
page, or any browser-viewable file) into a public share link. One command, prints the URL.

## Setup (once): connect the account

Run `login`. It opens a page in the browser where the user clicks Allow, then it saves a token
locally, so no one has to create or paste one by hand.

```bash
node "<path-to-this-skill>/scripts/login.mjs"
```

- It prints a link and a short code, and tries to open the link in the browser. The user signs in
  (if needed), checks the code matches, and clicks **Allow**.
- The token is saved to `~/.config/yarrtifacts/config.json` and read from there on every upload. It
  never passes through the chat — do not ask the user to paste a token.
- `node login.mjs status` checks whether the saved token still works; `node login.mjs logout` forgets it.

**Fallback (CI / no browser):** set `YARRTIFACTS_TOKEN` to a token created in the dashboard
(**API tokens** → Create token). The env var takes precedence over the saved config.

## Publish

```bash
node "<path-to-this-skill>/scripts/upload.mjs" <folder-or-file> [--title "My report"] [--slug my-report]
```

- `<path-to-this-skill>` is the directory containing this SKILL.md (you know it — you just read
  this file from it). There is no standard environment variable for it; substitute the real path.
- On success, every line after `artifactId: <id>` is a working link to the same artifact: subdomain,
  path, and the branded one if a custom domain is attached. Give the user all of them as a short
  list, not a wall of raw stdout:

  ```
  https://my-report.arrtifacts.com/
  https://arrtifacts.com/a/my-report/
  https://brand.example.com/my-report/
  ```

  Lead with the result, not a preamble. Don't say "Here are all the various links you can now use to
  access your newly published artifact, listen..."; say "Published:" and list them.
- `--title` names the artifact in the user's library. `--slug` requests a specific link name;
  omit it for a random one. If the slug is taken, the command fails with a clear message.

## Update a published artifact (keep the same link)

```bash
node "<path-to-this-skill>/scripts/upload.mjs" <folder-or-file> --replace <artifactId>
```

- The publish command prints `artifactId: <id>` on the line before the URL — remember it whenever
  the user might iterate on the artifact. The link stays the same; the content flips to the new
  version. (Lost it? It's visible in the dashboard, not to the token.)
- `--title` and `--slug` do not combine with `--replace`; the command rejects that.

## Custom domains (if you've attached one)

If the account has exactly one active custom domain, its branded link gets added automatically;
you don't need to set anything up. With two or more, the first publish after they're all attached
(or after the set changes) still succeeds and prints the subdomain and path links. A note on stderr
lists the candidates and asks you to check with the user, then re-run the same command with
`--default-domain <hostname>` (or `--default-domain none` to skip a branded link) to save the choice
and add the branded link from then on. That preference is stored locally and won't be asked again
unless the attached domains change.

To set or change it without publishing anything:

```bash
node "<path-to-this-skill>/scripts/upload.mjs" --default-domain <hostname|none>
```

## Rename or change the link (no re-upload)

```bash
node "<path-to-this-skill>/scripts/upload.mjs" --edit <artifactId> [--title "New title"] [--slug new-slug] [--default-domain <hostname|none>]
```

- Pass `--title`, `--slug`, `--default-domain`, or any combination — at least one is required.
  Neither `--title` nor `--slug` re-uploads content or touches the current version; they only edit
  the artifact's title and/or public link. `--default-domain` alone (no `--title`/`--slug`) just
  resolves and saves the branded-domain preference — see "Custom domains" below.
- On success, `artifactId: <id>` prints first; a slug change then prints every resolved link
  (subdomain, path, and branded if one resolved) the same way a publish does (a title-only edit has
  no link to print). Give the new links to the user if the slug changed.
- Changing the slug moves the public link immediately — the old one stops serving and may be
  claimed by someone else after a short cooldown, so warn the user before changing a link they've
  already shared.
- `--edit` does not combine with `--replace`, `--abandon`, or a folder path.

## On failure

The script prints the server's message to stderr and exits non-zero. Show that message to the
user as-is. If a create failed partway, stderr also names the leftover draft's id — pass
`--abandon <id>` on the retry so the server reclaims it. Common cases:

| Status | Meaning |
|---|---|
| 401 | Token invalid or revoked. Run `login` again to reconnect (or set a fresh `YARRTIFACTS_TOKEN`). |
| 403 "token scope" | This token can only upload, replace, rename, or change the slug of artifacts it owns. Anything else needs the dashboard. |
| 409 "slug taken" | Pick another `--slug`, or omit it. |
| 413 | A file is over 95 MB, the bundle is over 200 MB, or a file grew after upload started. |
| 429 | Rate limit. Wait a minute, retry once. |
| 400 "unsupported type" | Only browser-viewable files publish (pages, Markdown, code, images, fonts, PDF). No zip/exe/docx. |

## Limits

Up to 200 files, 95 MB per file, 200 MB per bundle. Only browser-viewable file types.

## Wire protocol

If the script cannot run (no Node), drive the REST API directly with any HTTP client —
the 4-step flow (init → PUT each file → finalize) is documented in `references/api.md`.
