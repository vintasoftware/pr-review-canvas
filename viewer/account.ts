// The sign-in control the viewer adds to every page: a button that starts GitHub sign-in, or the
// signed-in login with a sign-out command. Only drawn when the build has a GitHub App configured.
import type { Auth } from './auth.js'

export interface ViewerAuthConfig {
  clientId: string
  workerUrl: string
  /** Where an owner installs the app, built from its slug; absent when the build names none. */
  installUrl?: string
}

/** The sign-in settings the build was given, or null when it has none and stays anonymous. */
export function authConfigFrom(env: Record<string, string | undefined>): ViewerAuthConfig | null {
  const clientId = env['VITE_GITHUB_CLIENT_ID']?.trim()
  const workerUrl = env['VITE_AUTH_WORKER_URL']?.trim()
  if (!clientId || !workerUrl) return null
  const slug = env['VITE_GITHUB_APP_SLUG']?.trim()
  return {
    clientId,
    workerUrl,
    ...(slug ? { installUrl: `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` } : {}),
  }
}

/**
 * What is wrong with the sign-in settings, or null. A GitHub App's settings page shows its App ID,
 * a number, above its Client ID, and GitHub answers 404 to an authorize URL that names the number.
 */
export function configProblem(config: ViewerAuthConfig): string | null {
  if (/^\d+$/.test(config.clientId)) {
    return `VITE_GITHUB_CLIENT_ID is ${config.clientId}, which looks like the app's App ID; set it to the Client ID from the same settings page and restart the dev server`
  }
  return null
}

/** Where to go back to after sign-in: a path on this site, never another origin. */
export function safeReturnTo(raw: string): string {
  return raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : '/'
}

/**
 * Draws the control into `host`, and again whenever the session changes. Returns a function that
 * says one line next to it, as when GitHub stops accepting the token.
 */
export function renderAccount(
  host: HTMLElement,
  opts: {
    auth: Auth
    redirectUri: string
    /** The signed-in login, once known. */
    login: () => Promise<string | null>
    /** A sign-in that just failed, said once. */
    notice: string | null
  }
): (message: string) => void {
  const { auth } = opts
  let notice = opts.notice

  const draw = () => {
    host.replaceChildren()
    if (notice !== null) {
      const alert = document.createElement('span')
      alert.className = 'viewer-account-notice'
      alert.setAttribute('role', 'alert')
      alert.textContent = notice
      host.append(alert)
      notice = null
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cmd'
    if (!auth.signedIn()) {
      const status = document.createElement('span')
      status.className = 'viewer-account-status'
      status.textContent = 'Reading anonymously: public pull requests only.'
      host.append(status)
      button.textContent = 'sign in with GitHub'
      button.title = 'Read private repositories the GitHub App is installed on, and resolved threads'
      button.addEventListener('click', () => {
        button.disabled = true
        const here = `${location.pathname}${location.search}${location.hash}`
        void auth.signInUrl(opts.redirectUri, here).then(url => location.assign(url))
      })
      host.append(button)
      return
    }
    const who = document.createElement('span')
    who.className = 'viewer-account-status'
    who.textContent = 'Signed in to GitHub.'
    void opts.login().then(login => {
      if (login !== null) who.textContent = `Signed in to GitHub as @${login}.`
      return login
    })
    button.textContent = 'sign out'
    button.title = 'Forget the GitHub token on this tab'
    button.addEventListener('click', () => {
      auth.signOut()
      location.reload()
    })
    host.append(who, button)
  }

  auth.onChange(draw)
  draw()
  return message => {
    notice = message
    draw()
  }
}
