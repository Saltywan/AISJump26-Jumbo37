import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
var apiTarget = process.env.API_TARGET || "http://api:8000";
var pagesTarget = process.env.PAGES_TARGET || "http://pages:80";
// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    server: {
        host: true,
        port: 5173,
        strictPort: true,
        allowedHosts: true,
        proxy: {
            "/api": {
                target: apiTarget,
                changeOrigin: true,
                rewrite: function (path) { return path.replace(/^\/api/, ""); },
            },
            "/pages": {
                target: pagesTarget,
                changeOrigin: true,
            },
            "/drafts": {
                target: pagesTarget,
                changeOrigin: true,
            },
            "/generated": {
                target: pagesTarget,
                changeOrigin: true,
            },
            "/lib": {
                target: pagesTarget,
                changeOrigin: true,
            },
        },
    },
});
