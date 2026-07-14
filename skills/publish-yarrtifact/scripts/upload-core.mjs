/**
 * Wire core of the publish-yarrtifact skill: init → PUT files → finalize against the
 * yarrtifacts.com API, authorized by a Bearer PAT. Pure JS with an injectable fetch —
 * no node imports — so the product repo CI runs this exact file against the real app
 * and the published skill can never drift from the server contract.
 */

export class UploadError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/** The failure line agents see: the API's human message, else its error code, else the status. */
export function formatFailure(status, body) {
  return (body && (body.message || body.error)) || ("HTTP " + status);
}

// Single source of truth for "is there anything to edit", shared by validateArgs' CLI-args-shaped
// check and editArtifact's own opts-shaped guard (their field names differ — CLI uses `edit`,
// editArtifact's opts use `artifactId` — so this takes just the two values that actually matter,
// not a whole args/opts object, keeping both callers' messages from drifting apart independently.
function requireEditField(title, slug) {
  // Presence check, not truthiness: --title "" is a real request (clear the title, mirroring the
  // dashboard's own rename field), not "not provided" — a falsy check would silently drop it.
  if (title === undefined && slug === undefined) {
    throw new UploadError("Nothing to edit: pass --title and/or --slug with --edit.");
  }
}

/** --title/--slug shape the CREATE call and --abandon reclaims a failed CREATE draft; the replace
 *  route ignores all three, so combining any with --replace would silently drop user intent.
 *  --edit (#60) is a distinct metadata-only mode (no re-upload): checked FIRST and returns early,
 *  so combining it with --replace gets --edit's own accurate message, not the create/replace one. */
export function validateArgs(args) {
  if (args.edit) {
    if (args.replace || args.abandon || args.dir) {
      throw new UploadError("--edit only combines with --title and/or --slug (it edits an existing artifact's metadata, no re-upload). Remove --replace, --abandon, or the folder path.");
    }
    requireEditField(args.title, args.slug);
    return;
  }
  if (args.replace && (args.title || args.slug || args.abandon)) {
    throw new UploadError("--title, --slug and --abandon only apply when creating a new artifact. Remove them, or drop --replace.");
  }
}

export function encodePath(rel) {
  return rel.split("/").map(encodeURIComponent).join("/");
}

/** Actual byte length of a PUT body (utf-8 for strings). Sent as an explicit Content-Length so the
 *  server's declared-size check applies even through in-process test bridges; real HTTP stacks
 *  compute the same value themselves. */
export function bodyByteLength(body) {
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  return body.byteLength ?? body.length ?? 0;
}

async function jsonOrThrow(res) {
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body: fall through to the status line */ }
  if (!res.ok) throw new UploadError(formatFailure(res.status, body), res.status);
  return body || {};
}

/** True for a genuine connectivity failure (offline / DNS / reset — Node's undici surfaces it as a
 *  bare "TypeError: fetch failed" with a `.cause`), so we don't relabel an unrelated throw (e.g. a
 *  malformed URL from a bad --api) as a network problem. */
export function isTransportError(e) {
  if (e && e.cause !== undefined) return true;
  return /fetch failed|network|socket|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|dns/i.test(String((e && e.message) || e));
}

/** fetch + jsonOrThrow, but a TRANSPORT failure becomes a friendly "retry" UploadError instead of an
 *  opaque TypeError. A NON-transport throw (bad URL, etc.) surfaces its real message, not masked as
 *  network. HTTP errors still flow through jsonOrThrow with the server's message. */
async function request(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    if (isTransportError(e)) throw new UploadError("Network error: couldn't reach the server. Check your connection and try again.");
    throw new UploadError(String((e && e.message) || e));
  }
  return jsonOrThrow(res);
}

// Normalize a pasted API origin: strip trailing slashes so "https://x.com/" + "/api/…" doesn't
// yield a //api pathname that matches no route (a very confusing 403). Shared by uploadFiles and
// editArtifact so a future fix to this rule can't land in one and be forgotten in the other.
function normalizeOrigin(origin) {
  return String(origin || "").replace(/\/+$/, "");
}

// Bearer auth header, alone (PUT/finalize) or extended with the JSON content-type (init/replace/
// rename/slug). Shared by uploadFiles and editArtifact for the same reason as normalizeOrigin.
function authHeaders(token, withJson) {
  const auth = { authorization: "Bearer " + token };
  return withJson ? { ...auth, "content-type": "application/json" } : auth;
}

/**
 * Upload `files` ([{relativePath, size, body|readBody}]) as one artifact.
 * opts: { apiOrigin, token, files, title?, slug?, replace?, abandon? } — `replace`/`abandon` are
 * existing artifact ids (replace = new version of it; abandon = reclaim a failed create draft).
 * Returns { url, slug, artifactId, versionId, published }; throws UploadError with the server's
 * message (on a create-path failure the thrown error carries `.artifactId` of the leftover draft).
 */
export async function uploadFiles(opts, fetchImpl) {
  const { token, files, title, slug, replace, abandon } = opts;
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  validateArgs(opts);
  if (!files || !files.length) throw new UploadError("Nothing to upload: the folder has no files.");
  const auth = authHeaders(token);
  const jsonHeaders = authHeaders(token, true);
  const manifest = files.map((f) => ({ relativePath: f.relativePath, size: f.size }));

  let artifactId, versionId, slugOut;
  if (replace) {
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(replace) + "/replace", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ manifest }),
    });
    artifactId = replace;
    versionId = j.versionId;
    slugOut = j.slug;
  } else {
    const body = { manifest };
    if (title) body.title = title;
    if (slug) body.slug = slug;
    if (abandon) body.abandon = abandon; // reclaim the caller's own failed prior draft (server-side owner+status-scoped delete)
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/init", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(body),
    });
    artifactId = j.artifactId;
    versionId = j.versionId;
    slugOut = j.slug;
  }

  // PUTs are independent of each other (only init-before / finalize-after are ordered), so run a
  // small pool. Bodies come from `body` or a lazy `readBody()` (so only in-flight files sit in RAM).
  const PUT_CONCURRENCY = 4;
  let next = 0;
  let aborted = false;
  async function putWorker() {
    while (!aborted && next < files.length) {
      const f = files[next++];
      // Read the body first — a LOCAL read failure is reported as such (distinct from a transfer
      // failure). Both set `aborted` so siblings stop picking up the rest of a doomed bundle.
      let body;
      try {
        body = f.body !== undefined ? f.body : f.readBody ? f.readBody() : undefined;
        if (body === undefined) throw new Error("neither body nor readBody");
      } catch (e) {
        aborted = true;
        throw new UploadError("Could not read " + f.relativePath + ": " + String((e && e.message) || e));
      }
      try {
        await request(fetchImpl,
          apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/files/" + encodePath(f.relativePath),
          { method: "PUT", headers: { ...auth, "content-length": String(bodyByteLength(body)) }, body },
        );
      } catch (e) {
        aborted = true;
        throw e; // already an UploadError (HTTP or transport), rethrown to stop the pool
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PUT_CONCURRENCY, files.length) }, putWorker));

    const fin = await request(fetchImpl,
      apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/finalize",
      { method: "POST", headers: auth },
    );
    // Servers from v0.18 return the fully-qualified `url`; older ones only the bare subdomain host.
    // `published: false` = the version stored but the artifact is unpublished, so the link is dormant.
    return {
      url: fin.url || ("https://" + fin.subdomainUrl + "/"),
      slug: fin.slug || slugOut,
      artifactId,
      versionId,
      published: fin.published !== false,
    };
  } catch (e) {
    // A failure after init leaves a draft behind (create path). Attach the id to WHATEVER was
    // thrown — including a transport-level TypeError from the finalize fetch, which is exactly when
    // the draft is most certainly orphaned — so the caller can report it and pass it back as
    // `abandon` on the retry for the server to reclaim.
    if (!replace && artifactId && e && typeof e === "object") {
      try { e.artifactId = artifactId; } catch { /* frozen error object: nothing to attach to */ }
    }
    throw e;
  }
}

/**
 * Rename and/or change the slug of an already-published artifact — no re-upload (#60).
 * opts: { apiOrigin, token, artifactId, title?, slug? }. Sequenced title-first, slug-second: if the
 * slug call fails after the title already committed, the thrown error carries `.partial.title` so
 * the caller can report the partial success instead of implying nothing happened.
 * Returns { artifactId, title?, slug?, url?, published? } (url/published are set only when the
 * slug changed; published:false means the new link is dormant — the artifact isn't live).
 */
export async function editArtifact(opts, fetchImpl) {
  const { token, artifactId, title, slug } = opts;
  // Self-validating, like uploadFiles' validateArgs(opts) call: any caller of the exported function
  // (not just upload.mjs's CLI branch) gets this error instead of a silent artifactId-only no-op.
  // Shares requireEditField with validateArgs' --edit branch so the two can't drift apart.
  requireEditField(title, slug);
  const apiOrigin = normalizeOrigin(opts.apiOrigin);
  const jsonHeaders = authHeaders(token, true);
  const out = { artifactId };

  if (title !== undefined) {
    const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/rename", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ title }),
    });
    out.title = j.title;
  }
  if (slug !== undefined) {
    try {
      const j = await request(fetchImpl, apiOrigin + "/api/artifacts/" + encodeURIComponent(artifactId) + "/slug", {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ slug }),
      });
      out.slug = j.slug;
      out.url = j.url;
      out.published = j.published;
    } catch (e) {
      if (out.title !== undefined && e && typeof e === "object") {
        try { e.partial = { title: out.title }; } catch { /* frozen error object: nothing to attach to */ }
      }
      throw e;
    }
  }
  return out;
}
