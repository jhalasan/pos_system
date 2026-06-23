export const THEME_STORAGE_KEY = 'nexa_pos_theme';
export const THEMES = {
  light: 'light',
  dark: 'dark',
};

export function getStoredTheme() {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === THEMES.dark ? THEMES.dark : THEMES.light;
  } catch {
    return THEMES.light;
  }
}

export function applyTheme(theme) {
  const nextTheme = theme === THEMES.dark ? THEMES.dark : THEMES.light;
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.classList.toggle('theme-dark', nextTheme === THEMES.dark);
  document.documentElement.classList.toggle('theme-light', nextTheme !== THEMES.dark);
}

export function saveTheme(theme) {
  const nextTheme = theme === THEMES.dark ? THEMES.dark : THEMES.light;
  localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  applyTheme(nextTheme);
  window.dispatchEvent(new CustomEvent('nexa-theme-change', { detail: { theme: nextTheme } }));
  return nextTheme;
}
