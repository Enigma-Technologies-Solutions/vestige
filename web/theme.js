// Applies a saved theme before first paint. Without one, the page follows the system setting.
try {
  const theme = localStorage.getItem('vestige-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {}
