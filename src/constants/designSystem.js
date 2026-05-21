// Design System - Color Palette
export const COLORS = {
  // Primary backgrounds
  primaryBg: '#f4f4f4',
  cardBg: '#ffffff',
  
  // Sidebar
  sidebarBg: '#166534',
  sidebarActive: '#15803d',
  
  // Buttons
  primary: '#16a34a',
  primaryHover: '#15803d',
  primaryActive: '#14532d',
  secondary: '#2563eb',
  secondaryHover: '#1d4ed8',
  destructive: '#dc2626',
  destructiveHover: '#b91c1c',
  
  // Status colors
  success: '#16a34a',
  warning: '#f59e0b',
  error: '#dc2626',
  info: '#2563eb',
  
  // Text
  textPrimary: '#030213',
  textSecondary: '#717182',
  textMuted: '#9ca3af',
  
  // Borders
  border: 'rgba(0, 0, 0, 0.1)',
  borderLight: '#e5e7eb',
  borderDark: '#d1d5db',
  
  // Backgrounds for states
  bgLight: '#f9fafb',
  bgLighter: '#fafafa',
  bgLightest: '#f3f4f6',
};

// Typography
export const TYPOGRAPHY = {
  fontFamily: {
    base: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    mono: '"Courier New", monospace',
  },
  fontSize: {
    xs: '12px',
    sm: '14px',
    base: '16px',
    lg: '18px',
    xl: '20px',
    '2xl': '24px',
    '3xl': '30px',
  },
  fontWeight: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
  },
  lineHeight: {
    tight: '1.2',
    normal: '1.5',
    relaxed: '1.6',
  },
};

// Spacing System
export const SPACING = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
  '3xl': '48px',
};

// Border Radius
export const BORDER_RADIUS = {
  sm: '6px',
  md: '8px',
  lg: '10px',
  full: '12px',
};

// Shadows
export const SHADOWS = {
  card: '0 1px 3px rgba(0, 0, 0, 0.1)',
  modal: '0 4px 12px rgba(0, 0, 0, 0.15)',
  hover: '0 8px 24px rgba(0, 0, 0, 0.2)',
};

// Transitions
export const TRANSITIONS = {
  fast: '0.2s ease',
  normal: '0.3s ease',
  slow: '0.5s ease',
};

// Z-Index
export const Z_INDEX = {
  base: 1,
  dropdown: 100,
  sticky: 500,
  fixed: 1000,
  modal: 9999,
};

// Breakpoints
export const BREAKPOINTS = {
  mobile: '640px',
  tablet: '1024px',
  desktop: '1440px',
};

export default {
  COLORS,
  TYPOGRAPHY,
  SPACING,
  BORDER_RADIUS,
  SHADOWS,
  TRANSITIONS,
  Z_INDEX,
  BREAKPOINTS,
};
