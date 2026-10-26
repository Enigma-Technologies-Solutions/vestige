# Writing a blog post

How a post goes from a Markdown file in `blog-src/` to a page at `/blog/<slug>/` on the
Vestige site. The blog is static HTML with no JavaScript, built by one dependency-free Node
script and styled by the lab's own `web/styles.css`. Run everything from the repo root.

```
blog-src/2026-10-25-introducing-vestige.md      you write this
        │
        └── npm run blog:build                  → web/blog/index.html          (post list)
            (scripts/build-blog.mjs)            → web/blog/<slug>/index.html   (one per post)
```

Never hand-edit anything in `web/blog/`: each build empties it (except `.gitkeep`) and writes it
again from `blog-src/`.

## 1. Prerequisites

| Tool | Why | Check |
|---|---|---|
| Node.js 20 or later | Runs `scripts/build-blog.mjs`. It uses only Node built-ins, so `npm install` is not needed for the blog. | `node --version` |
| A static file server | Local preview. `npm run serve` (the lab server) or `python3 -m http.server`. | `python3 --version` |

There are no images to generate: posts are text only.

## 2. Create the post file

Create `blog-src/YYYY-MM-DD-slug.md`. The file name must be exactly the `date` and `slug`
from the frontmatter joined by a hyphen, or the build fails.

```markdown
---
title: "Why the window is signed by A"
date: "2026-11-02"
slug: "why-the-window-is-signed"
excerpt: "maxAge lives inside what A signs, so neither the relayer nor B can stretch it."
draft: "true"
---

First paragraph.

## A section

More text.
```

Start every post with `draft: "true"` and delete that line when it is ready (step 7).
`blog-src/2026-10-25-introducing-vestige.md` is a starting template, still a draft.

## 3. Frontmatter fields

One `key: "value"` per line. Every value must be in double quotes; there is no YAML, so no
lists, multi-line values or comments. An unknown key is a build error.

| Field | Required | Format | What it does |
|---|---|---|---|
| `title` | Yes | Plain text, at most 90 characters | The post's `<h1>`, its heading on `/blog/`, and the page `<title>`. |
| `date` | Yes | `YYYY-MM-DD` | Shown on the post and in the list; sorts the list, newest first. Must match the file name. |
| `slug` | Yes | Lower-case words joined by hyphens (`a-z`, `0-9`, `-`) | The URL, `/blog/<slug>/`. Must match the file name and be unique. |
| `excerpt` | Yes | One or two sentences, at most 220 characters | The summary under the title on `/blog/`, and the page's meta description. |
| `draft` | No | Exactly `"true"`, or absent | Keeps the post out of `web/blog/`. Any other value is a build error. |

### What the body may contain

A strict Markdown subset. Anything outside it fails the build with the line number, so what
you preview is what ships.

- Headings `##` to `####` (`#` is reserved for the title), each with an id from its text
  (`## Use it` → `/blog/<slug>/#use-it`), paragraphs, `**strong**`,
  `*emphasis*`, `` `code` ``, fenced code blocks, bullet and numbered lists (one level), and
  `>` block quotes.
- Links: `[text](https://...)` for other sites, or `[text](/path)` for pages on this site
  (for example `[the lab](/lab/)` or `[another post](/blog/other-slug/)`).
- Not allowed: images, tables, nested lists, CRLF line endings, and any link scheme other
  than `https://` or `/`. Raw HTML is shown as text, never rendered.

## 4. Build

```bash
npm run blog:build
```

Rewrites `web/blog/` from every published post (drafts are skipped and counted in the
output). Run it after any change in `blog-src/`, including deleting or renaming a post.

`npm run blog:check` exits non-zero if the committed `web/blog/` differs from what
`blog-src/` would build. Run it before committing, or in CI.

## 5. Style

Pages use the lab's stylesheet: the `.blog*` rules at the end of `web/styles.css`. The page
template (nav, footer, CSP) is `shell()` in `scripts/build-blog.mjs`. The CSP forbids inline
styles and scripts, so a style change goes in `web/styles.css`, never in a post.

## 6. Preview locally

A published post (no `draft` line), after step 4:

```bash
npm run serve
# → http://localhost:8080/blog/
```

A draft, without touching `web/blog/`:

```bash
npm run blog:preview        # writes every post, drafts included, to web/.blog-preview/
npm run serve
# → http://localhost:8080/.blog-preview/
```

Drafts are marked `· draft` next to the date. `web/.blog-preview/` is git-ignored; delete it
when you are done. The **Blog** link in the preview's nav goes to the real `/blog/`, not the
preview.

## 7. Publish

1. Delete the `draft: "true"` line.
2. `npm run blog:build`.
3. `npm run blog:check` (should print "Blog up to date").
4. Commit `blog-src/<file>.md` **and** `web/blog/` together.
5. Push to `main`.

The site has no automatic deploy today: `web/` is served by `npm run serve`. Wherever `web/`
is hosted, the post appears at `/blog/<slug>/` once that copy of `web/` includes the commit.
The landing page and the lab link to `/blog/` from their nav and footer.

To unpublish a post, add `draft: "true"` back and rebuild; the build removes its folder.
