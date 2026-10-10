import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Build and test configuration, replacing Create React App.
 *
 * WHY THE MIGRATION: every high-severity advisory `npm audit` reported against
 * this package was transitive through react-scripts (nth-check, postcss,
 * serialize-javascript, svgo) and build-time only — none of it reached a
 * browser. That is a true statement nobody outside the team can verify from a
 * questionnaire, so it cost a week of correspondence per client review. CRA is
 * also unmaintained, so the list only grows. Removing the toolchain removes the
 * findings at the source.
 */
export default defineConfig(({ mode }) => {
  /**
   * The deploy-time API origin, kept under its ORIGINAL name.
   *
   * Vite's own convention would be `VITE_API_URL` on `import.meta.env`, and this
   * config deliberately does not adopt it. `REACT_APP_API_URL` is already set by
   * docker-compose.yml, by Dockerfile.web's build arg and by whatever a client
   * has wired into their own pipeline; renaming it would silently drop the value
   * on the next deploy, and a dropped value does not fail the build — it starts
   * the app in SINGLE-USER mode against localStorage while the operator believes
   * they are talking to their tenant's database. The variable is mapped onto the
   * identifier src/lib/api.js already reads, so no source file and no deployment
   * has to change.
   *
   * loadEnv also picks the name up from the real process environment, not just
   * .env files, which is how the Docker build arg reaches it.
   */
  const env = loadEnv(mode, process.cwd(), 'REACT_APP_');

  return {
    // The CRA `homepage: "."` equivalent: emit `./assets/...` rather than
    // `/assets/...`, so one build serves from a domain root AND from a repo
    // subpath. Absolute paths 404 on GitHub Pages.
    base: './',

    // Present for `npm start` only. Vite 8's builtin transform already compiles
    // the .jsx files with the automatic runtime, so removing this plugin changes
    // neither the build (byte-identical bundle hash) nor the suite (all 1073
    // still pass) — both checked. What it adds is React Fast Refresh: without it
    // every edit is a full page reload and the deal you were mid-way through
    // entering is gone.
    plugins: [react()],

    build: {
      // CRA emitted to build/. Dockerfile.web copies ./build and CI greps
      // build/index.html, so the directory is pinned rather than left at Vite's
      // dist/ default — a rename here is a silently empty container image.
      outDir: 'build',
      sourcemap: true,
      // Stated explicitly because Vite does not read the browserslist field CRA
      // used, and the default ('baseline-widely-available', roughly Safari 16)
      // is a NARROWER floor than the one this app shipped under. es2020 is the
      // honest bound: the page loads as a single type="module" script, so a
      // browser without ES modules never gets here anyway.
      target: 'es2020',
      // NOT @vitejs/plugin-legacy. That plugin is the one thing in the Vite
      // ecosystem that injects inline <script> into index.html (its nomodule
      // Safari fix and its polyfill detector), and the deployed CloudFront CSP
      // has no 'unsafe-inline' on script-src. This is the replacement for CRA's
      // INLINE_RUNTIME_CHUNK=false: there is no runtime chunk to inline, so the
      // only way to get an inline script here is to add that plugin. CI asserts
      // the result rather than trusting this comment.
    },

    // Applied for `serve` and `build`, but NOT for `test`. The multi-tenant suite
    // reassigns process.env.REACT_APP_API_URL between tests and re-imports the
    // modules; a compile-time replacement would freeze it and turn those 16
    // tests into a second copy of the single-user suite.
    //
    // Read the guard as intent, not as a live fix. Vitest as it stands does not
    // apply `define` to the transform it uses — removing this condition and
    // re-running the suite changes nothing, which was checked rather than
    // assumed — so today it is inert. It stays because the two environments want
    // genuinely different things from this value and nothing here guarantees
    // Vitest keeps that behaviour. `mode` really is 'test' under Vitest and
    // 'production' under `vite build`; that was checked too.
    define: mode === 'test' ? {} : {
      'process.env.REACT_APP_API_URL': JSON.stringify(env.REACT_APP_API_URL ?? ''),
    },

    test: {
      // jsdom is not a default under Vitest the way it was under CRA's jest
      // preset; without it `document` is undefined and every screen test fails
      // at the harness's createElement, not at anything it is testing.
      environment: 'jsdom',
      // describe/it/expect/vi as globals, matching what the 25 suites were
      // written against. Porting 1073 tests to explicit imports would be a large
      // diff across files whose contents are the thing that must not change.
      globals: true,
      // Scoped to src/ on purpose. server/ and infra/ are separate packages with
      // their own runners and their own *.test.js files; Vitest's default
      // include would sweep them into this run and fail on their imports.
      include: ['src/**/*.test.{js,jsx}'],
      // CRA's jest preset set resetMocks: true; Vitest's default is off. Every
      // suite here already cleans up after itself, so turning this off changes
      // nothing today — 1073 still pass, which was checked rather than assumed.
      // It is set because of WHAT is spied on: Storage.prototype.setItem, a
      // global these suites replace to simulate a full quota. A spy left
      // installed there does not fail the file that installed it; it fails a
      // later, unrelated file, and the run then accuses the wrong code.
      restoreMocks: true,
    },
  };
});
