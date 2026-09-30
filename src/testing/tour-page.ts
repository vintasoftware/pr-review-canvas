// The tour page's bundle for the synthetic pull request, for the browser modules' tests.
import { freshReaderState, type TourBundle, type TourPageTour } from '../contract/tour-api.js'
import { syntheticTour } from './synthetic-tour.js'

export function syntheticPageTour(): TourPageTour {
  const tour = syntheticTour()
  return {
    ...tour,
    landmarks: tour.landmarks.map(({ scene, micro, ...rest }) => ({
      ...rest,
      scene: typeof scene === 'string',
      micro: typeof micro === 'string',
    })),
  }
}

export function syntheticTourBundle(over: Partial<TourBundle> = {}): TourBundle {
  const tour = syntheticPageTour()
  return {
    status: 'ready',
    key: 42,
    pr: tour.pr,
    tour,
    reader: freshReaderState(),
    reviewer: { login: 'octocat', author: true },
    preview: false,
    shares: true,
    options: { finalQuiz: 'on', reverseQuiz: 'on', grill: 'change', audio: 'on' },
    chat: { enabled: false, acpx: false },
    skillCommand: '/pr-tour 42',
    warnings: [],
    ...over,
  }
}

/** The bundle before any tour exists for the target. */
export function missingTourBundle(over: Partial<Omit<TourBundle, 'tour'>> = {}): TourBundle {
  const { tour: _tour, ...rest } = syntheticTourBundle()
  return { ...rest, status: 'missing', ...over }
}
