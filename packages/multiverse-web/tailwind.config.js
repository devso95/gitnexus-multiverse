/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0f1117',
        surface: '#1a1d27',
        surface2: '#242836',
        border: '#2e3348',
        text: '#e4e6f0',
        text2: '#8b8fa8',
        accent: '#6c5ce7',
        accent2: '#a29bfe',
        ok: '#00b894',
        warn: '#fdcb6e',
        err: '#e17055',
        info: '#74b9ff',
        kafka: '#ff7675',
      },
    },
  },
  plugins: [],
};
