#!/usr/bin/env node
/**
 * publish-yarrtifact CLI shell: walks a folder (or takes one file), then hands the wire work to
 * upload-core.mjs. Node >= 18 (global fetch), zero dependencies.
 *
 * Output contract for agents:
 *   success → the share URL is the bare last line of stdout
 *   failure → the server's message on stderr, exit code 1
 */
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { uploadFiles, validateArgs, UploadError } from "./upload-core.mjs";
import { resolveAuth } from "./config.mjs";

// Mirrors the server's junk filter in src/shared/junk.ts (kept in sync by
// test/integration/agent-skill-contract.test.ts). SEGMENTS match any path segment (a file OR
// directory named .git / __macosx is dropped); BASENAMES match a FILE's name only (a directory
// named .ds_store is legitimate content the server keeps).
const JUNK_SEGMENTS = new Set([".git", "__macosx"]);
const JUNK_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function walk(root) {
  const out = [];
  const rootReal = realpathSync(root);
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const lower = name.toLowerCase();
      // A .git / __macosx segment is dropped whatever its type (matches the server).
      if (JUNK_SEGMENTS.has(lower)) continue;
      let st = lstatSync(p);
      if (st.isSymbolicLink()) {
        // Follow a FILE symlink ONLY if it resolves to a target still inside the chosen folder —
        // never publish files outside the folder the user pointed at (an attacker-planted
        // data.txt -> ~/.ssh/id_rsa in an untrusted checkout would otherwise be exfiltrated to a
        // public URL). Directory symlinks and out-of-tree / broken links are skipped LOUDLY.
        let real;
        try { real = realpathSync(p); } catch { console.error("skipping broken symlink: " + relative(root, p)); continue; }
        if (real !== rootReal && !real.startsWith(rootReal + sep)) { console.error("skipping symlink outside the folder: " + relative(root, p)); continue; }
        const target = statSync(p);
        if (!target.isFile()) { console.error("skipping symlinked directory: " + relative(root, p)); continue; }
        st = target;
      }
      if (st.isDirectory()) {
        stack.push(p);
      } else if (!JUNK_BASENAMES.has(lower)) {
        // Exact byte sizes are part of the API contract: the server rejects a body that
        // materially exceeds its declared manifest size. Bodies are read lazily at PUT time
        // (readBody) so a 200 MB bundle is never held in memory all at once.
        out.push({ relativePath: relative(root, p).split(sep).join("/"), size: st.size, readBody: () => readFileSync(p) });
      }
    }
  }
  return out;
}

const USAGE = "Usage: node upload.mjs <folder-or-file> [--title <t>] [--slug <s>] [--replace <artifactId>] [--abandon <artifactId>] [--api <origin>]";

function parseArgs(argv) {
  const a = {}; // a.api stays undefined unless --api is passed, so resolveAuth can fall back to the saved origin
  const rest = [];
  const val = (v) => { const x = argv[++i]; if (x === undefined) throw new UploadError("Missing value for " + v + "\n" + USAGE); return x; };
  let i = 0;
  for (; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--") { for (i++; i < argv.length; i++) rest.push(argv[i]); break; } // end-of-options: a path literally named --foo
    else if (v === "--title") a.title = val(v);
    else if (v === "--slug") a.slug = val(v);
    else if (v === "--replace") a.replace = val(v);
    else if (v === "--abandon") a.abandon = val(v);
    else if (v === "--api") a.api = val(v);
    else if (v.startsWith("--")) throw new UploadError("Unknown flag: " + v + "\n" + USAGE);
    else rest.push(v);
  }
  a.dir = rest[0];
  return a;
}

async function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    if (!a.dir) throw new UploadError(USAGE);
    // Token + origin, coherently (env token → prod; config token → its saved origin; --api wins).
    const { token, apiOrigin } = resolveAuth(a.api);
    if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
    validateArgs(a);
    const st = statSync(a.dir);
    const files = st.isDirectory()
      ? walk(a.dir)
      : [{ relativePath: basename(a.dir), size: st.size, readBody: () => readFileSync(a.dir) }];
    const out = await uploadFiles({ apiOrigin, token, files, title: a.title, slug: a.slug, replace: a.replace, abandon: a.abandon }, fetch);
    if (!out.published) console.error("Note: this artifact is unpublished, so the link is dormant. Publish it in the dashboard to make it live.");
    // artifactId first (agents remember it for --replace), then the contract: URL = bare last line.
    console.log("artifactId: " + out.artifactId);
    console.log(out.url);
  } catch (e) {
    console.error(e instanceof UploadError ? e.message : String(e));
    if (e && e.artifactId) {
      console.error("A draft artifact was left behind (id " + e.artifactId + "). Add --abandon " + e.artifactId + " to your retry to reclaim it, or delete it in the dashboard.");
    }
    process.exit(1);
  }
}
main();
