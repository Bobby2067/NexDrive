/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: "#030811", // Deep midnight blue
        blue: "#025ca5", // NexDrive Blue
        accent: "#8cc63f", // NexDrive Green
        background: "#FAF8F5",
        slate: "#1e293b",
      },
      fontFamily: {
        heading: ['Inter', 'sans-serif'],
        drama: ['"Playfair Display"', 'serif'],
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
}
