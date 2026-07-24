#!/usr/bin/env node
/**
 * publish-yarrtifact CLI shell: walks a folder (or takes one file), then hands the wire work to
 * upload-core.mjs. Node >= 18 (global fetch), zero dependencies.
 *
 * Output contract for agents:
 *   success → artifactId line, then every resolved share link (subdomain, path, and branded custom
 *             domain if one resolved this run) — hand ALL of them to the user, not just one
 *   failure → the server's message on stderr, exit code 1
 */
import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, basename, sep } from "node:path";
import { uploadFiles, editArtifact, validateArgs, UploadError, setDefaultDomain } from "./upload-core.mjs";
import { resolveAuth, readConfig, updateConfig } from "./config.mjs";
import { maybeOpen } from "./browser.mjs";

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

const USAGE = "Usage: node upload.mjs <folder-or-file> [--title <t>] [--slug <s>] [--replace <artifactId>] [--abandon <artifactId>] [--api <origin>] [--default-domain <hostname|none>] [--no-open]\n   or: node upload.mjs --edit <artifactId> [--title <t>] [--slug <s>] [--api <origin>] [--default-domain <hostname|none>] [--no-open]\n   or: node upload.mjs --default-domain <hostname|none> [--api <origin>]";

function parseArgs(argv) {
  const a = { open: true }; // a.api stays undefined unless --api is passed, so resolveAuth can fall back to the saved origin
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
    else if (v === "--edit") a.edit = val(v);
    else if (v === "--api") a.api = val(v);
    else if (v === "--default-domain") a.defaultDomain = val(v);
    else if (v === "--no-open") a.open = false; // don't open the published link in the browser
    else if (v.startsWith("--")) throw new UploadError("Unknown flag: " + v + "\n" + USAGE);
    else rest.push(v);
  }
  a.dir = rest[0];
  return a;
}

/** The confirmation line for a resolved --default-domain value, shared by the standalone
 *  `--default-domain` path and the --edit path's configPatch-only fallback (#64) so the wording
 *  can't drift between the two. */
function formatDefaultDomainMessage(value) {
  return value === "none" ? "Default custom domain: none (no branded link by default)." : "Default custom domain set to " + value + ".";
}

/** Prints the non-blocking "ambiguous default domain" hint to stderr — never called on a failure
 *  path, always alongside a SUCCESSFUL publish/edit's own output (#64). */
function printDomainHint(prompt) {
  if (!prompt) return;
  console.error("Multiple custom domains are set up and none is chosen as a default yet (or the list changed):");
  for (const host of prompt.candidates) console.error("  - " + host);
  console.error('Ask the user which one to use as the default branded link (or "none"), then re-run with --default-domain <hostname-or-none> to save the choice and add the branded link next time.');
}

async function main() {
  try {
    const a = parseArgs(process.argv.slice(2));
    const cfg = readConfig() || {};
    const domainOpts = { defaultDomain: cfg.defaultDomain, defaultDomainSnapshot: cfg.defaultDomainSnapshot, defaultDomainOverride: a.defaultDomain };

    // Standalone --default-domain (#64): NO other flag at all — just set the preference and exit.
    // A narrower guard (e.g. just !a.dir && !a.edit) would let a mistyped `--replace <id>
    // --default-domain host` or `--title "" --default-domain host` (folder omitted) silently take
    // this branch instead of hitting the usual "missing folder" error, quietly dropping the
    // create/replace/rename the caller actually asked for. Presence checks, not truthiness — an
    // explicit --title "" is a real request (see requireEditField above), not "not provided".
    if (a.defaultDomain !== undefined && !a.dir && !a.edit && !a.replace && !a.abandon && a.title === undefined && a.slug === undefined) {
      const { token, apiOrigin } = resolveAuth(a.api);
      if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
      const out = await setDefaultDomain({ apiOrigin, token, defaultDomainOverride: a.defaultDomain }, fetch);
      updateConfig(out.configPatch);
      console.log(formatDefaultDomainMessage(out.defaultDomain));
      return;
    }

    // --edit (#60): rename/re-slug an already-published artifact, no re-upload, no folder walk.
    if (a.edit) {
      const { token, apiOrigin } = resolveAuth(a.api);
      if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
      validateArgs(a);
      const out = await editArtifact({ apiOrigin, token, artifactId: a.edit, title: a.title, slug: a.slug, ...domainOpts }, fetch);
      if (out.configPatch) updateConfig(out.configPatch);
      if (out.url && out.published === false) console.error("Note: this artifact is unpublished, so the new link is dormant. Publish it in the dashboard to make it live.");
      // artifactId first, then: a title-only edit has no URL (last lines stay "artifactId: …"); a
      // slug change prints every resolved link — subdomain, path, and branded if one resolved.
      console.log("artifactId: " + out.artifactId);
      if (out.title !== undefined) console.error("Renamed.");
      if (out.url) {
        console.log(out.url);
        if (out.pathUrl) console.log(out.pathUrl);
        if (out.customDomainUrl) console.log(out.customDomainUrl);
      } else if (out.configPatch) {
        // An edit that didn't change the slug (title-only, or --default-domain alone) has no route
        // to read the artifact's EXISTING slug, so there's no branded link to print THIS run even
        // though --default-domain resolved and saved the preference — say so, or it looks like a
        // no-op. It'll show starting from this artifact's next publish/replace/slug edit.
        console.log(formatDefaultDomainMessage(out.configPatch.defaultDomain));
      }
      printDomainHint(out.domainPrompt);
      if (out.domainOverrideError) console.error("Note: --default-domain not saved: " + out.domainOverrideError);
      // A slug change moved the link — open it (a title-only / default-domain-only edit has no
      // out.url, so maybeOpen no-ops). Never open a dormant (unpublished) link. Best-effort (#75).
      if (out.published !== false) maybeOpen(out, { open: a.open });
      return;
    }
    if (!a.dir) throw new UploadError(USAGE);
    // Token + origin, coherently (env token → prod; config token → its saved origin; --api wins).
    const { token, apiOrigin } = resolveAuth(a.api);
    if (!token) throw new UploadError("Not connected. Run `node login.mjs` to connect your account, or set YARRTIFACTS_TOKEN.");
    validateArgs(a);
    const st = statSync(a.dir);
    const files = st.isDirectory()
      ? walk(a.dir)
      : [{ relativePath: basename(a.dir), size: st.size, readBody: () => readFileSync(a.dir) }];
    const out = await uploadFiles({ apiOrigin, token, files, title: a.title, slug: a.slug, replace: a.replace, abandon: a.abandon, ...domainOpts }, fetch);
    if (out.configPatch) updateConfig(out.configPatch);
    if (!out.published) console.error("Note: this artifact is unpublished, so the link is dormant. Publish it in the dashboard to make it live.");
    // artifactId first (agents remember it for --replace), then every resolved link — subdomain,
    // path, and branded custom-domain if one resolved this run.
    console.log("artifactId: " + out.artifactId);
    console.log(out.url);
    if (out.pathUrl) console.log(out.pathUrl);
    if (out.customDomainUrl) console.log(out.customDomainUrl);
    printDomainHint(out.domainPrompt);
    if (out.domainOverrideError) console.error("Note: --default-domain not saved: " + out.domainOverrideError);
    // Open the published artifact in the browser (best link: branded if it resolved, else subdomain).
    // Never open a dormant (unpublished) link. Best-effort — a failed launch never changes the exit
    // code, and it runs AFTER the links are printed so the agent's output is unaffected (#75).
    if (out.published !== false) maybeOpen(out, { open: a.open });
  } catch (e) {
    if (e && e.partial && e.partial.title !== undefined) {
      console.error(e.partial.title === null ? "Note: the title was already cleared." : "Note: the title was already changed to \"" + e.partial.title + "\".");
    }
    console.error(e instanceof UploadError ? e.message : String(e));
    if (e && e.artifactId) {
      console.error("A draft artifact was left behind (id " + e.artifactId + "). Add --abandon " + e.artifactId + " to your retry to reclaim it, or delete it in the dashboard.");
    }
    process.exit(1);
  }
}
main();
