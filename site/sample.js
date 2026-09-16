// Excerpts from TanStack/query#9612 at the pinned head below. See public/tanstack-query-LICENSE.txt.
const sourceRoot = 'https://github.com/TanStack/query/blob/7922966810988298e6c40761b8888597d6e0e0d7/'

export const layers = {
  provider: {
    category: 'PROVIDER API',
    title: 'Make the timer provider replaceable.',
    summary:
      'A manager delegates timer creation and cancellation to a configurable provider. Its new tests check that calls reach the provider.',
    path: 'query-core/src/timeoutManager.ts',
    related: 'query-core/src/__tests__/timeoutManager.test.tsx',
    test: 'Added test: proxies calls to the configured timeout provider',
    point: 'When can a provider change?',
    'point-body':
      'Check what happens to existing timer IDs if a different provider is installed after timers have started.',
    source: `${sourceRoot}packages/query-core/src/timeoutManager.ts#L101-L109`,
    code: [
      '+  setTimeout(callback: TimeoutCallback, delay: number): ManagedTimerId {',
      "+    if (process.env.NODE_ENV !== 'production') {",
      '+      this.#providerCalled = true',
      '+    }',
      '+    return this.#provider.setTimeout(callback, delay)',
      '+  }',
      '+',
      '+  clearTimeout(timeoutId: ManagedTimerId | undefined): void {',
      '+    this.#provider.clearTimeout(timeoutId)',
    ],
  },
  timers: {
    category: 'QUERY LIFECYCLE',
    title: 'Create and clear timers together.',
    summary:
      'Route stale, refetch, and garbage-collection timers through the manager. Follow both creation and cancellation across the core and persisters.',
    path: 'query-core/src/queryObserver.ts',
    related: 'query-core/src/removable.ts',
    test: 'Review check: pair manager creation with manager cancellation',
    point: 'Same provider, both directions.',
    'point-body':
      'A timer created by the manager also needs to be cleared through it. Inspect the cancellation changes in this file.',
    source: `${sourceRoot}packages/query-core/src/queryObserver.ts#L367-L375`,
    code: [
      '     // To mitigate this issue we always add 1 ms to the timeout.',
      '     const timeout = time + 1',
      ' ',
      '-    this.#staleTimeoutId = setTimeout(() => {',
      '+    this.#staleTimeoutId = timeoutManager.setTimeout(() => {',
      '       if (!this.#currentResult.isStale) {',
      '         this.updateResult()',
      '       }',
    ],
  },
  scheduling: {
    category: 'NOTIFICATION SCHEDULING',
    title: 'Keep next-tick scheduling intact.',
    summary:
      'Notifications use a helper that calls the global zero-delay timer directly. This scheduling stays separate from the configurable provider.',
    path: 'query-core/src/notifyManager.ts',
    related: 'query-persist-client-core/src/createPersister.ts',
    test: 'Related test in layer 01: systemSetTimeoutZero uses global timers',
    point: 'A deliberate boundary.',
    'point-body':
      'The shared helper and its test belong to the provider layer. Refer back to them when checking this scheduling change.',
    source: `${sourceRoot}packages/query-core/src/notifyManager.ts#L13-L18`,
    code: [
      ' type ScheduleFunction = (callback: () => void) => void',
      ' ',
      '-export const defaultScheduler: ScheduleFunction = (cb) => setTimeout(cb, 0)',
      '+export const defaultScheduler: ScheduleFunction = systemSetTimeoutZero',
      ' ',
      ' export function createNotifyManager() {',
      '   let queue: Array<NotifyCallback> = []',
    ],
  },
}

export const questions = {
  scheduling: {
    question: 'Does changing the timer provider also change notification scheduling?',
    answer:
      'No. The default notification scheduler uses systemSetTimeoutZero, which calls global setTimeout(callback, 0) directly. The provider controls managed timers. The added test checks that zero-delay scheduling still uses the global timer after a custom provider is installed.',
    reference: 'Read the zero-delay scheduling test ↗',
    source: `${sourceRoot}packages/query-core/src/__tests__/timeoutManager.test.tsx#L113-L131`,
  },
  switching: {
    question: 'Can I safely switch providers after timers have started?',
    answer:
      'Set the provider before creating queries. Existing timer IDs belong to the previous provider, while later cancellation calls go to the current one. This change warns in development if a different provider is installed after a timer call; it neither migrates timers nor blocks the switch.',
    reference: 'Read provider switching and its warning ↗',
    source: `${sourceRoot}packages/query-core/src/timeoutManager.ts#L72-L109`,
  },
}
