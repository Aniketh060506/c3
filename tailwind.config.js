/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'c3-bg': '#090a0f',
        'c3-card': '#121620',
        'c3-border': '#1e2535',
        'c3-muted': '#8892a4',
        'c3-accent': '#3b82f6',
        'c3-accent-hover': '#2563eb',
        'c3-success': '#22c55e',
        'c3-warning': '#f59e0b',
        'c3-danger': '#ef4444',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Inter', 'Segoe UI', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};
