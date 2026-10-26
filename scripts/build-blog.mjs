#!/usr/bin/env node
// Builds the blog: blog-src/<date>-<slug>.md becomes web/blog/index.html and
// web/blog/<slug>/index.html. Static HTML, no JavaScript on the page, same CSP and
// stylesheet as the lab. Authoring guide: docs/blog.md.
//
//   node scripts/build-blog.mjs                  write web/blog/ (published posts only)
//   node scripts/build-blog.mjs --check          fail if web/blog/ differs from blog-src/
//   node scripts/build-blog.mjs --preview DIR    write every post, drafts included, to DIR
//
// web/blog/ is fully generated: everything in it except .gitkeep is replaced on each build.
// A --preview directory is only written into, never emptied.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(repo, 'blog-src');
const OUT = join(repo, 'web/blog');

export class PostError extends Error {}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ── Frontmatter ─────────────────────────────────────────────────────────────

const KNOWN = new Set(['title', 'date', 'slug', 'excerpt', 'draft']);

/** `key: "value"` lines between two `---` fences. No YAML. */
export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new PostError('post has no frontmatter (it must start with ---)');
  const data = {};
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const kv = /^([a-z_]+):\s*"(.*)"\s*$/.exec(line);
    if (!kv) throw new PostError(`frontmatter line is not key: "value": ${line.slice(0, 40)}`);
    data[kv[1]] = kv[2];
  }
  return { data, body: m[2] };
}

/** Validate one post file. Returns { title, date, slug, excerpt, draft: boolean, html }. */
export function parsePost(file, text) {
  const where = `blog-src/${file}:`;
  if (/\r/.test(text)) throw new PostError(`${where} use LF line endings`);
  let parsed;
  try {
    parsed = frontmatter(text);
  } catch (e) {
    throw new PostError(`${where} ${e.message}`);
  }
  const { data, body } = parsed;
  for (const k of Object.keys(data)) if (!KNOWN.has(k)) throw new PostError(`${where} unknown key ${k}`);
  for (const k of ['title', 'date', 'slug', 'excerpt']) if (!data[k]) throw new PostError(`${where} missing ${k}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(`${data.date}T00:00:00Z`))) throw new PostError(`${where} date must be YYYY-MM-DD`);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(data.slug)) throw new PostError(`${where} slug must be lower-case words joined by hyphens`);
  if (file !== `${data.date}-${data.slug}.md`) throw new PostError(`${where} file name must be ${data.date}-${data.slug}.md`);
  if (data.title.length > 90) throw new PostError(`${where} title is over 90 characters`);
  if (data.excerpt.length > 220) throw new PostError(`${where} excerpt is over 220 characters`);
  if (data.draft !== undefined && data.draft !== 'true') throw new PostError(`${where} draft must be "true" or absent`);
  let html;
  try {
    html = markdown(body);
  } catch (e) {
    throw new PostError(`${where} ${e.message}`);
  }
  return { title: data.title, date: data.date, slug: data.slug, excerpt: data.excerpt, draft: data.draft === 'true', html };
}

// ── Markdown (strict subset) ────────────────────────────────────────────────
// Allowed: ## to #### headings, paragraphs, **strong**, *emphasis*, `code`, fenced code,
// one-level bullet and numbered lists, > block quotes, [text](https://... or /path) links.
// Anything that looks like raw HTML is escaped, not rendered. Images and tables are errors.

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;

function inline(text, n) {
  if (text.replace(/`[^`\n]*`/g, '').includes('![')) throw new Error(`line ${n}: images are not allowed`);
  let out = '';
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    out += esc(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) out += `<code>${esc(tok.slice(1, -1))}</code>`;
    else if (m[2]) out += `<strong>${inline(tok.slice(2, -2), n)}</strong>`;
    else if (m[3]) out += `<em>${inline(tok.slice(1, -1), n)}</em>`;
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      if (!/^(https:\/\/|\/(?!\/))/.test(href)) throw new Error(`line ${n}: link must be https://... or a site path starting with /: ${href}`);
      const ext = href.startsWith('https://');
      out += `<a href="${esc(href)}"${ext ? ' rel="noopener"' : ''}>${inline(label, n)}</a>`;
    }
    last = m.index + tok.length;
  }
  return out + esc(text.slice(last));
}

// Heading anchors: "Use it in a browser" becomes id="use-it-in-a-browser"; a repeat gets -2, -3…
const anchor = (text, seen) => {
  const base = text.replace(/`/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? base : `${base}-${count}`;
};

export function markdown(src) {
  const lines = src.split('\n');
  const out = [];
  const seen = new Map();
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const n = i + 1;
    if (!raw.trim()) { i++; continue; }
    if (/^```/.test(raw)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      if (i >= lines.length) throw new Error(`line ${n}: code fence is not closed`);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^# /.test(raw)) throw new Error(`line ${n}: # is the post title; start body headings at ##`);
    const h = /^(#{2,4}) (.+)$/.exec(raw);
    if (h) { out.push(`<h${h[1].length} id="${anchor(h[2].trim(), seen)}">${inline(h[2].trim(), n)}</h${h[1].length}>`); i++; continue; }
    if (/^\|/.test(raw)) throw new Error(`line ${n}: tables are not allowed`);
    if (/^\s+([-*]|\d+\.)\s/.test(raw)) throw new Error(`line ${n}: nested lists are not allowed`);
    const list = /^([-*]|\d+\.) /.exec(raw);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const re = ordered ? /^\d+\. (.*)$/ : /^[-*] (.*)$/;
      const items = [];
      while (i < lines.length && re.test(lines[i])) {
        items.push(`<li>${inline(re.exec(lines[i])[1], i + 1)}</li>`);
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    if (/^> ?/.test(raw)) {
      const buf = [];
      while (i < lines.length && /^> ?/.test(lines[i])) buf.push(lines[i++].replace(/^> ?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '), n)}</p></blockquote>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4} |> ?|[-*] |\d+\. |\|)/.test(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(' '), n)}</p>`);
  }
  return out.join('\n');
}

// ── Pages ───────────────────────────────────────────────────────────────────

const longDate = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function shell({ title, description, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<!-- Generated by scripts/build-blog.mjs from blog-src/. Do not edit; see docs/blog.md. -->
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; form-action 'none'; base-uri 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="light">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="preload" href="/assets/fonts/Inter-var.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/Poppins-700.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<nav class="nav" aria-label="Primary">
  <div class="wrap nav__inner">
    <a class="wordmark" href="/" aria-label="Vestige home">VESTIGE<span class="wordmark__sq" aria-hidden="true"></span></a>
    <div class="nav__links">
      <a href="/#how">How it works</a>
      <a href="/#modes">Modes</a>
      <a href="/#integrate">Integrate</a>
      <a href="/#deployments">Deployments</a>
      <a href="/blog/" aria-current="page">Blog</a>
    </div>
    <div class="nav__cta">
      <a class="btn btn--volt btn--sm" href="/lab/">Open the lab</a>
    </div>
  </div>
</nav>

<main id="main" class="section blog">
  <div class="wrap">
${body}
  </div>
</main>

<footer class="foot">
  <div class="wrap">
    <div class="foot__top">
      <div>
        <a class="wordmark" href="/">VESTIGE<span class="wordmark__sq" aria-hidden="true"></span></a>
        <p class="foot__blurb">On-chain proof that two P-256 keys co-signed a recent block. Live on Ethereum, Base and Monad at one address.</p>
      </div>
      <nav class="foot__links" aria-label="Footer">
        <a href="/lab/">Lab</a>
        <a href="/blog/">Blog</a>
        <a href="https://github.com/Enigma-Technologies-Solutions/vestige" rel="noopener">GitHub</a>
      </nav>
    </div>
    <div class="foot__bar">
      <span class="ets" aria-hidden="true">ETS</span>
      <span>© 2026 Enigma Technologies Solutions</span>
      <span class="foot__bar-sp">Vestige · blog</span>
    </div>
  </div>
</footer>
</body>
</html>
`;
}

export function indexPage(posts) {
  const items = posts
    .map(
      (p) => `      <article class="blog__item">
        <p class="blog__date">${esc(longDate(p.date))}${p.draft ? ' · draft' : ''}</p>
        <h2 class="blog__title"><a href="./${esc(p.slug)}/">${esc(p.title)}</a></h2>
        <p class="blog__excerpt">${esc(p.excerpt)}</p>
        <a class="blog__more" href="./${esc(p.slug)}/">Read more</a>
      </article>`,
    )
    .join('\n');
  const body = `    <p class="eyebrow">Blog</p>
    <h1 class="h2">Notes on Vestige</h1>
${posts.length ? `    <div class="blog__list">\n${items}\n    </div>` : '    <p class="lede blog__empty">No posts yet.</p>'}`;
  return shell({ title: 'Blog | Vestige', description: 'Notes on Vestige: co-signed recent block hashes verified on-chain with P-256 keys.', body });
}

export function postPage(post) {
  const body = `    <article class="blog__post">
    <p class="eyebrow"><a href="../">Blog</a>${post.draft ? ' · draft' : ''}</p>
    <p class="blog__date">${esc(longDate(post.date))}</p>
    <h1 class="h2 blog__h1">${esc(post.title)}</h1>
    <div class="blog__body">
${post.html}
    </div>
    <p class="blog__back"><a href="../">Back to the blog</a></p>
    </article>`;
  return shell({ title: `${post.title} | Vestige`, description: post.excerpt, body });
}

/** Every file the blog produces, keyed by path under the output directory. Newest first. */
export function renderBlog(all, { includeDrafts = false } = {}) {
  const posts = all.filter((p) => includeDrafts || !p.draft).sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
  const seen = new Set();
  for (const p of posts) {
    if (seen.has(p.slug)) throw new PostError(`duplicate slug ${p.slug}`);
    seen.add(p.slug);
  }
  const files = new Map([['index.html', indexPage(posts)]]);
  for (const p of posts) files.set(`${p.slug}/index.html`, postPage(p));
  return { files, posts };
}

export function loadPosts(dir = SRC) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => parsePost(f, readFileSync(join(dir, f), 'utf8')));
}

/** Files currently in `dir`, as paths relative to it, ignoring .gitkeep. */
function listFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return listFiles(p, base);
    return e.name === '.gitkeep' ? [] : [relative(base, p)];
  });
}

function main(argv) {
  const check = argv.includes('--check');
  const pi = argv.indexOf('--preview');
  if (pi >= 0 && !argv[pi + 1]) throw new PostError('--preview needs a directory');
  const preview = pi >= 0 ? resolve(argv[pi + 1]) : null;
  const { files, posts } = renderBlog(loadPosts(), { includeDrafts: !!preview });
  const outDir = preview ?? OUT;
  const drafts = loadPosts().filter((p) => p.draft).length;

  if (check) {
    const stale = [];
    for (const [rel, text] of files) {
      const f = join(outDir, rel);
      if (!existsSync(f) || readFileSync(f, 'utf8') !== text) stale.push(`web/blog/${rel}`);
    }
    for (const rel of listFiles(outDir)) if (!files.has(rel)) stale.push(`web/blog/${rel} (no longer generated)`);
    if (stale.length) {
      console.error(`web/blog/ is out of date:\n${stale.map((s) => `  ${s}`).join('\n')}\nRun: npm run blog:build`);
      process.exit(1);
    }
    console.log(`Blog up to date (${posts.length} published, ${drafts} draft${drafts === 1 ? '' : 's'}).`);
    return;
  }

  // Start clean so a renamed, deleted or re-drafted post leaves nothing behind. Only
  // web/blog/ is ever emptied; a --preview directory is written into, never cleared.
  if (!preview) for (const e of existsSync(OUT) ? readdirSync(OUT) : []) if (e !== '.gitkeep') rmSync(join(OUT, e), { recursive: true });
  for (const [rel, text] of files) {
    const f = join(outDir, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
  }
  const where = relative(repo, outDir);
  console.log(`${preview ? 'Preview' : 'Blog'}: ${posts.length} post${posts.length === 1 ? '' : 's'} in ${where}/${!preview && drafts ? ` (${drafts} draft${drafts === 1 ? '' : 's'} skipped)` : ''}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof PostError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
