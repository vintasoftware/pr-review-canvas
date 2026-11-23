/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The GitHub App's client ID. With the Worker URL, it turns sign-in on. */
  readonly VITE_GITHUB_CLIENT_ID?: string
  /** Where the auth Worker answers, as `https://auth.example.com`. */
  readonly VITE_AUTH_WORKER_URL?: string
  /** The GitHub App's slug, to link its install page when a private repository is not found. */
  readonly VITE_GITHUB_APP_SLUG?: string
  /** The short commit the build was made from, set by viewer/vite.config.js. */
  readonly VITE_VIEWER_COMMIT?: string
}
