// @ts-check
import { cssEscape } from './anchors.js'

/**
 * Marks the sidebar link for the section being read.
 * @param {ParentNode} root
 * @param {string} anchorId
 */
export function markRailCurrent(root, anchorId) {
  for (const link of root.querySelectorAll('nav.rail a[href]')) {
    if (link.getAttribute('href') === `#${anchorId}`) {
      if (link.getAttribute('aria-current') !== 'location') {
        link.setAttribute('aria-current', 'location')
      }
    } else {
      link.removeAttribute('aria-current')
    }
  }
}

/**
 * Follows the section at the upper third of the viewport. Section sizes can change as diffs
 * and diagrams load, so those changes also update the selection. A hidden section (the page
 * showing one layer at a time hides the others) is not on screen and is never the one read.
 * @param {HTMLElement} root
 */
export function initScrollSpy(root) {
  const sections = Array.from(root.querySelectorAll('nav.rail a[href^="#"]')).flatMap(link => {
    const id = link.getAttribute('href')?.slice(1) ?? ''
    const section = id === '' ? null : root.querySelector(`#${cssEscape(id)}`)
    return section instanceof HTMLElement ? [section] : []
  })
  let frame = 0
  const update = () => {
    frame = 0
    const shown = sections.filter(section => !section.hidden)
    let active = shown[0]
    for (const section of shown) {
      if (section.getBoundingClientRect().top > window.innerHeight / 3) {
        break
      }
      active = section
    }
    if (active !== undefined) {
      markRailCurrent(root, active.id)
    }
  }
  const schedule = () => {
    if (frame === 0) {
      frame = window.requestAnimationFrame(update)
    }
  }
  const observer = new ResizeObserver(schedule)
  for (const section of sections) {
    observer.observe(section)
  }
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)
  update()
  return {
    stop() {
      window.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    },
  }
}
