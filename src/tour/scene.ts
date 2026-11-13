// Turns a scene's icon names into the icons themselves, so the frame it is drawn in loads nothing.
import { iconSvg } from './icons.js'

/** Replaces every `<i data-icon="name" class="…"></i>` with the named icon, keeping its classes. */
export function inlineIcons(html: string): string {
  return html.replace(
    /<i\b([^>]*)\bdata-icon\s*=\s*["']([^"']*)["']([^>]*)>\s*<\/i>/gi,
    (whole, before: string, name: string, after: string) => {
      const svg = iconSvg(name)
      if (svg === null) return ''
      const classes = /\bclass\s*=\s*["']([^"']*)["']/i.exec(`${before} ${after}`)?.[1] ?? ''
      return classes === ''
        ? svg
        : svg.replace('class="icon"', `class="icon ${classes.replace(/[^\w -]/g, '')}"`)
    }
  )
}
