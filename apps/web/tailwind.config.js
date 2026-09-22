/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#e8e8ed',
        muted: '#8a8a98',
        accent: '#e11d2e',
        surface: '#121218',
        background: '#0a0a0f',
      },
    },
  },
  plugins: [],
};
