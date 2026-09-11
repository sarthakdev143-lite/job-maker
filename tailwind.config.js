/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0e1116', soft: '#1a1f27', line: '#272d38' },
        paper: { DEFAULT: '#fbfbfa', soft: '#f2f2ef', line: '#e3e3de' },
        accent: { DEFAULT: '#3b6ef5', soft: '#e8eeff' },
        good: '#1a7f5a', warn: '#b45309', bad: '#b4232a',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
}
