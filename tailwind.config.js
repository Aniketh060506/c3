/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx,html}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['"Outfit"', '"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      colors: {
        canvas: {
          light: '#f6f8fc',
          subtle: '#eef2f9',
          dark: '#0c0f17',
        },
      },
      borderRadius: {
        '2.5xl': '1.25rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
        '5xl': '2.5rem',
      },
      boxShadow: {
        'card': '0 4px 20px -2px rgba(15, 23, 42, 0.05), 0 2px 6px -1px rgba(15, 23, 42, 0.02)',
        'card-hover': '0 20px 35px -4px rgba(15, 23, 42, 0.08), 0 8px 16px -2px rgba(15, 23, 42, 0.03)',
        'hero': '0 25px 50px -12px rgba(15, 23, 42, 0.25)',
        'glow-indigo': '0 10px 30px -5px rgba(99, 102, 241, 0.25)',
        'glow-emerald': '0 10px 30px -5px rgba(16, 185, 129, 0.25)',
        'glow-purple': '0 10px 30px -5px rgba(168, 85, 247, 0.25)',
        'glow-sky': '0 10px 30px -5px rgba(14, 165, 233, 0.25)',
      },
    },
  },
  plugins: [],
};
