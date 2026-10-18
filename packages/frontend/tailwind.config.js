/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Instrument Sans Variable"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "sans-serif",
        ],
      },
      fontSize: {
        // Smallest step of the scale — replaces ad-hoc text-[10px]/[11px].
        "2xs": ["11px", "14px"],
      },
      colors: {
        // The one accent. Hex (not CSS vars) so `/30`-style opacity
        // modifiers keep working. White text on 600 is ~5.5:1.
        brand: {
          50: "#f3f0ff",
          100: "#e6e0fd",
          200: "#cfc3fb",
          300: "#b6a6f7",
          400: "#9d88f0",
          500: "#8268e6",
          600: "#6e52d6",
          700: "#5c41b8",
          800: "#4a3594",
          900: "#3a2c70",
          950: "#221a42",
        },
        // Surface roles, darkest to lightest.
        canvas: "#0d0c12",
        surface: "#15141c",
        raised: "#1e1c26",
        line: { DEFAULT: "#2a2833", strong: "#3b3946" },
        // Secondary text roles. Both clear WCAG AA (4.5:1) on canvas,
        // surface and raised — neutral-500/600 did not.
        muted: "#a6a3b3",
        faint: "#8a8797",
      },
      keyframes: {
        shimmer: {
          "100%": { transform: "translateX(100%)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        shimmer: "shimmer 1.6s infinite",
        "fade-in": "fade-in 240ms ease both",
      },
    },
  },
  plugins: [],
};
