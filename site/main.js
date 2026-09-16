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

for (const button of document.querySelectorAll('[data-question]')) {
  button.addEventListener('click', () => {
    const question = questions[button.dataset.question]
    for (const other of document.querySelectorAll('[data-question]')) {
      other.setAttribute('aria-pressed', String(other === button))
    }
    setText('chat-question', question.question)
    setText('chat-answer', question.answer)
    setText('chat-reference', question.reference)
    document.getElementById('chat-reference').href = question.source
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
