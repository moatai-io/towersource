# Frontend development

`npm run dev:frontend` starts Vite on port 32354 with `NODE_ENV=development`, regardless of the caller's environment. This is limited to the development command; production builds retain their own environment.

Vite can otherwise serve a production-prebundled `react/jsx-dev-runtime` to development-transformed JSX. That runtime has no `jsxDEV` implementation, so the browser stays on the static “Tower Loading...” fallback even when `/` and `/api/health` return 200. The guard is `src/dev-server-react-runtime.source.test.ts`. For a browser smoke check, run `PLAYWRIGHT_USE_EXISTING_SERVER=1 npx playwright test e2e/tower-smoke.spec.ts` against the already-running development server. Applying a changed dev command to an existing server requires a separately approved restart; a source edit alone does not replace the running process.
