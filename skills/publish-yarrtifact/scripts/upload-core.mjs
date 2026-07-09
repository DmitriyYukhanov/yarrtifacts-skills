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

/** --title/--slug shape the CREATE call and --abandon reclaims a failed CREATE draft; the replace
 *  route ignores all three, so combining any with --replace would silently drop user intent. */
export function validateArgs(args) {
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

/**
 * Upload `files` ([{relativePath, size, body|readBody}]) as one artifact.
 * opts: { apiOrigin, token, files, title?, slug?, replace?, abandon? } — `replace`/`abandon` are
 * existing artifact ids (replace = new version of it; abandon = reclaim a failed create draft).
 * Returns { url, slug, artifactId, versionId, published }; throws UploadError with the server's
 * message (on a create-path failure the thrown error carries `.artifactId` of the leftover draft).
 */
export async function uploadFiles(opts, fetchImpl) {
  const { token, files, title, slug, replace, abandon } = opts;
  // Normalize the origin: people paste origins with a trailing slash, and "https://x.com/" +
  // "/api/…" yields a //api pathname that matches no route (a very confusing 403).
  const apiOrigin = String(opts.apiOrigin || "").replace(/\/+$/, "");
  validateArgs(opts);
  if (!files || !files.length) throw new UploadError("Nothing to upload: the folder has no files.");
  const auth = { authorization: "Bearer " + token };
  const jsonHeaders = { ...auth, "content-type": "application/json" };
  const manifest = files.map((f) => ({ relativePath: f.relativePath, size: f.size }));

  let artifactId, versionId, slugOut;
  if (replace) {
    const j = await jsonOrThrow(await fetchImpl(apiOrigin + "/api/artifacts/" + encodeURIComponent(replace) + "/replace", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify({ manifest }),
    }));
    artifactId = replace;
    versionId = j.versionId;
    slugOut = j.slug;
  } else {
    const body = { manifest };
    if (title) body.title = title;
    if (slug) body.slug = slug;
    if (abandon) body.abandon = abandon; // reclaim the caller's own failed prior draft (server-side owner+status-scoped delete)
    const j = await jsonOrThrow(await fetchImpl(apiOrigin + "/api/artifacts/init", {
      method: "POST", headers: jsonHeaders, body: JSON.stringify(body),
    }));
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
        await jsonOrThrow(await fetchImpl(
          apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/files/" + encodePath(f.relativePath),
          { method: "PUT", headers: { ...auth, "content-length": String(bodyByteLength(body)) }, body },
        ));
      } catch (e) {
        aborted = true;
        throw e; // an HTTP error is already an UploadError; a transport reject propagates verbatim
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(PUT_CONCURRENCY, files.length) }, putWorker));

    const fin = await jsonOrThrow(await fetchImpl(
      apiOrigin + "/api/artifacts/" + artifactId + "/versions/" + versionId + "/finalize",
      { method: "POST", headers: auth },
    ));
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
