/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: '#030811',
        blue: '#025ca5',
        accent: '#8cc63f',
        background: '#FAF8F5',
        slate: '#1e293b',
        // Keep brand for internal app pages
        brand: {
          50: '#eff6ff',
          100: '#dbeafe',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        heading: ['Inter', 'sans-serif'],
        data: ['"JetBrains Mono"', 'monospace'],
      },
      animation: {
        'noise': 'noise 1s steps(2) infinite',
      },
      keyframes: {
        noise: {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '10%': { transform: 'translate(-5%, -5%)' },
          '20%': { transform: 'translate(-15%, 5%)' },
          '30%': { transform: 'translate(5%, -15%)' },
          '40%': { transform: 'translate(-5%, 15%)' },
          '50%': { transform: 'translate(-15%, 5%)' },
          '60%': { transform: 'translate(15%, 0)' },
          '70%': { transform: 'translate(0, 15%)' },
          '80%': { transform: 'translate(5%, 5%)' },
          '90%': { transform: 'translate(-10%, 10%)' },
        }
      }
    },
  },
  plugins: [],
};
