import { spawn } from 'node:child_process'

/** The platform's own opener, called without a shell so the URL is one argument and nothing more. */
function opener(url: string): [string, string[]] {
  if (process.platform === 'darwin') {
    return ['open', [url]]
  }
  if (process.platform === 'win32') {
    return ['explorer.exe', [url]]
  }
  return ['xdg-open', [url]]
}

/** Opens `url` in the default browser. A missing opener only logs: the server runs either way. */
export function openBrowser(url: string, log: (line: string) => void): void {
  const [command, args] = opener(url)
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.on('error', err => log(`could not open a browser (${err.message}); open ${url}`))
  child.unref()
}
