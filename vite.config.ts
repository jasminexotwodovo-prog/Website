import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: "/silkveil-pastel/",
  plugins: [react()],
  server: { port: 5173 }
})
