/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/views/**/*.ejs"],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: "#0c56d0", dim: "#004aba", soft: "#e7efff" },
        ink: { DEFAULT: "#29343a", muted: "#566168", faint: "#8b969e" },
        surface: { DEFAULT: "#f7f9fc", low: "#f0f4f8", mid: "#e8eff4" },
        line: "#e3e9ef",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Manrope", "Inter", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(41,52,58,0.04), 0 12px 32px -12px rgba(41,52,58,0.10)",
        pop: "0 8px 40px -8px rgba(41,52,58,0.25)",
      },
    },
  },
  plugins: [require("@tailwindcss/forms")],
};
