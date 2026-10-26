// Applies the theme saved by the lab's or deploy page's toggle before first paint. Without one, the page is light.
// The landing page and the blog do not load this: they are always light.
try {
  const theme = localStorage.getItem('vestige-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
