# yarrtifacts.com upload API

Base: `https://yarrtifacts.com`. Every request carries `Authorization: Bearer <token>` — a
personal access token (`yarr_pat_…`) created in the dashboard's **API tokens** tab. Tokens can
call exactly the four routes below; everything else answers `403 {"error":"token scope"}`.

## 1. Init

```
POST /api/artifacts/init
Content-Type: application/json

{ "manifest": [ { "relativePath": "index.html", "size": 1234 }, … ],
  "title": "My report",        // optional
  "slug": "my-report" }        // optional; omit for a random link
```

→ `200 { "artifactId": "…", "versionId": "…", "slug": "…" }`

`size` must be the file's exact byte length — a PUT body materially larger than its declared
size is rejected. All files must be browser-viewable types (pages, Markdown, code, text/data,
images, SVG, fonts, PDF). Limits: 200 files, 95 MB per file, 200 MB per bundle.

## 2. Upload each file

```
PUT /api/artifacts/{artifactId}/versions/{versionId}/files/{path}
<raw file bytes>
```

`{path}` is the manifest's `relativePath` with each segment URI-encoded
(`img dir/a b.svg` → `img%20dir/a%20b.svg`). → `200 { "ok": true }`

## 3. Finalize

```
POST /api/artifacts/{artifactId}/versions/{versionId}/finalize
```

→ `200 { "url": "https://<slug>.arrtifacts.com/", "slug": "…", "versionId": "…",
         "pathUrl": "/a/<slug>/", "subdomainUrl": "<slug>.arrtifacts.com" }`

`url` is the shareable link.

## 4. Replace (new version, same link)

```
POST /api/artifacts/{artifactId}/replace
Content-Type: application/json

{ "manifest": [ … ] }
```

→ `200 { "versionId": "…", "slug": "…" }` — then repeat steps 2 and 3 with the new `versionId`.
`title`/`slug` are ignored here; rename and slug edits live in the dashboard.

## Errors

Every error is JSON: `{ "error": "<code>", "message": "<human text>" }` (`message` may be
absent). Show `message`, falling back to `error`, falling back to the HTTP status.

| Status | error | Notes |
|---|---|---|
| 401 | `invalid token` | Unknown or revoked token. |
| 403 | `token scope` | Route outside the four above. |
| 400 | `bad manifest` / `bad entry` / `duplicate path: …` / `unsupported type: …` / `unsafe path: …` / `invalid slug` / `file too large` / `bundle too large` | Manifest problems at init (size caps checked against declared sizes return 400 here). |
| 409 | `slug taken` / `entry` / `still processing` / `version not writable` / `replace conflict` | Conflicts; `entry` = no clear entry point (add index.html). |
| 413 | `file too large` / `size mismatch` / `bundle too large` | Upload-time caps: a PUT body over 95 MB or beyond its declared size; a finalize whose stored bundle exceeds 200 MB. |
| 422 | `incomplete` | Some files never arrived; re-upload and finalize again. |
| 429 | `rate limited` | Per-owner/IP budget; honor `retry-after`. |
