import { layers, questions } from './sample.js'

const layerButtons = [...document.querySelectorAll('[data-layer]')]
const reviewed = new Set()
let currentLayer = 'provider'

function setText(id, value) {
  document.getElementById(id).textContent = value
}

function updateProgress() {
  for (const button of layerButtons) {
    const done = reviewed.has(button.dataset.layer)
    button.querySelector('.layer-check').textContent = done ? '✓' : ''
    button.setAttribute(
      'aria-label',
      `${button.querySelector('strong').textContent}${done ? ', reviewed' : ''}`
    )
  }
  setText('sample-progress', `${reviewed.size} of 3 sample layers reviewed`)
  document.getElementById('progress-fill').style.width = `${(reviewed.size / 3) * 100}%`
  const done = reviewed.has(currentLayer)
  document.getElementById('review-layer').setAttribute('aria-pressed', String(done))
  setText('review-layer', done ? 'Reviewed ✓' : 'Mark reviewed')
}

for (const button of layerButtons) {
  button.addEventListener('click', () => {
    currentLayer = button.dataset.layer
    const layer = layers[currentLayer]
    for (const other of layerButtons) other.setAttribute('aria-pressed', String(other === button))
    for (const [field, value] of Object.entries(layer)) {
      if (field !== 'code' && field !== 'source') setText(`sample-${field}`, value)
    }
    document.getElementById('sample-source').href = layer.source
    document.getElementById('sample-code').replaceChildren(
      ...layer.code.map(line => {
        const span = document.createElement('span')
        span.className = line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : 'context'
        span.textContent = line
        return span
      })
    )
    updateProgress()
  })
}

document.getElementById('review-layer').addEventListener('click', () => {
  if (reviewed.has(currentLayer)) reviewed.delete(currentLayer)
  else reviewed.add(currentLayer)
  updateProgress()
})

const chatDock = document.querySelector('.canvas-chat-dock')
const chatExample = document.querySelector('.chat-demo')
if (chatDock && chatExample) {
  const panel = chatExample.cloneNode(true)
  panel.id = 'canvas-chat-panel'
  panel.classList.add('canvas-chat-panel')
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', 'AI Chat about this PR')
  panel.hidden = true
  for (const element of panel.querySelectorAll('[id]')) element.id = `canvas-${element.id}`
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'canvas-chat-close'
  close.setAttribute('aria-label', 'Close AI chat')
  close.textContent = '×'
  panel.querySelector('.chat-demo-header').append(close)
  chatDock.prepend(panel)
  chatDock.hidden = false
  const launcher = chatDock.querySelector('.canvas-chat-launcher')
  function toggleChat(open) {
    panel.hidden = !open
    launcher.setAttribute('aria-expanded', String(open))
    if (open) close.focus({ preventScroll: true })
    else launcher.focus({ preventScroll: true })
  }
  launcher.addEventListener('click', () => toggleChat(panel.hidden))
  close.addEventListener('click', () => toggleChat(false))
  panel.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault()
      toggleChat(false)
    }
  })
}

for (const button of document.querySelectorAll('[data-question]')) {
  button.addEventListener('click', () => {
    const question = questions[button.dataset.question]
    const chat = button.closest('.chat-demo')
    for (const other of chat.querySelectorAll('[data-question]')) {
      other.setAttribute('aria-pressed', String(other === button))
    }
    chat.querySelector('.user-message').textContent = question.question
    chat.querySelector('.agent-message p').textContent = question.answer
    const reference = chat.querySelector('.chat-code-ref')
    reference.textContent = question.reference
    reference.href = question.source
  })
}

for (const button of document.querySelectorAll('.copy-button')) {
  button.addEventListener('click', async () => {
    const command = button.parentElement.querySelector('code').textContent
    try {
      await navigator.clipboard.writeText(command)
      setText('copy-status', 'Commands copied to clipboard.')
      button.textContent = 'Copied!'
      setTimeout(() => {
        button.textContent = 'Copy'
      }, 2000)
    } catch {
      setText('copy-status', 'Clipboard unavailable. Select and copy the command text.')
      button.textContent = 'Select text to copy'
    }
  })
}
