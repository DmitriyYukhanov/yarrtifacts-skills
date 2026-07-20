# yarrtifacts agent skill

Lets an AI agent (Claude Code, Codex CLI, Gemini CLI, Cursor, and anything else that reads
[Agent Skills](https://agentskills.io)) publish a local folder or file as a shareable web page
on [yarrtifacts.com](https://yarrtifacts.com) and hand back the link. It can also push a new
version of an already published artifact, so the link you shared keeps working.

## Connect your account

Run `login`. It opens a page in your browser, you click Allow, and it saves a token locally. No
copy-pasting.

```bash
node skills/publish-yarrtifact/scripts/login.mjs
```

The token is saved to `~/.config/yarrtifacts/config.json` and used automatically on every upload.
`login status` checks it's still good; `login logout` forgets it.

A token can only upload, replace, rename, or change the slug of artifacts it owns. Everything else,
including deleting and domain setup, stays in the dashboard, where you can also revoke the token any
time.

**CI or no browser?** Create a token in the dashboard (**API tokens** → Create token) and set it as
an environment variable — it takes precedence over the saved login:

```bash
export YARRTIFACTS_TOKEN=yarr_pat_…
```

## Install

**Claude Code** (as a plugin):

```
/plugin marketplace add DmitriyYukhanov/yarrtifacts-skills
/plugin install yarrtifacts@yarrtifacts
```

**Any skills-compatible agent** via [skills.sh](https://skills.sh):

```bash
npx skills add DmitriyYukhanov/yarrtifacts-skills
```

**Manual** — copy `skills/publish-yarrtifact/` into your agent's skills directory:

| Agent | Directory |
|---|---|
| Claude Code | `~/.claude/skills/` or `<project>/.claude/skills/` |
| OpenAI Codex CLI | `~/.agents/skills/` or `<project>/.agents/skills/` |
| Gemini CLI | `~/.gemini/skills/` or `<project>/.gemini/skills/` |
| Others | see your agent's skills documentation |

## Use

Ask your agent to "publish this folder as an artifact" (or run it yourself):

```bash
node skills/publish-yarrtifact/scripts/upload.mjs ./report --title "Q3 report"
# → https://q3-report.arrtifacts.com/
```

Update it later without changing the link:

```bash
node skills/publish-yarrtifact/scripts/upload.mjs ./report --replace <artifactId>
```

Rename an artifact, or move its link, without re-uploading:

```bash
node skills/publish-yarrtifact/scripts/upload.mjs --edit <artifactId> --title "New title"
node skills/publish-yarrtifact/scripts/upload.mjs --edit <artifactId> --slug new-slug
```

Changing the slug moves the public link right away, and the old one stops working. Worth checking
first if you already shared it. You can pass both flags at once, but the rename lands first, so a
slug that turns out to be taken leaves the new title already applied.

Once a custom domain is active, the branded link comes back automatically (a domain still waiting on
DNS gets skipped). If you have two or more, mark one as the primary in the dashboard and it's used
automatically everywhere — nothing to set here. Or pick which one the CLI uses by default per-run:

```bash
node skills/publish-yarrtifact/scripts/upload.mjs --default-domain <hostname>
```

No Node.js? The REST flow is four curl calls — see
[`skills/publish-yarrtifact/references/api.md`](skills/publish-yarrtifact/references/api.md).

## Limits

200 files, 95 MB per file, 200 MB per bundle. Browser-viewable file types only (HTML, Markdown,
code, text/data, images, SVG, fonts, PDF).
