// Reading stats: streak, time read, and the last four weeks as columns of dots.

import { $, el, showSheet } from './ui.js'
import { summary, formatDuration } from './stats.js'

const ROWS = 7

function chart(series) {
  const max = Math.max(20 * 60, ...series) // a column is full at the best day, or at least twenty minutes
  const P = 14, R = 4.4
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `0 0 ${series.length * P} ${ROWS * P}`)
  svg.setAttribute('class', 'stats-chart')
  svg.setAttribute('role', 'img')
  const mins = series.map(s => Math.round(s / 60))
  svg.setAttribute('aria-label', `Minutes read on each of the last ${series.length} days, oldest first: ${mins.join(', ')}`)
  series.forEach((secs, x) => {
    const lit = secs >= 60 ? Math.max(1, Math.round((secs / max) * ROWS)) : 0
    for (let y = 0; y < ROWS; y++) {
      const c = document.createElementNS(NS, 'circle')
      c.setAttribute('cx', String(x * P + P / 2)); c.setAttribute('cy', String((ROWS - 1 - y) * P + P / 2)); c.setAttribute('r', String(R))
      c.setAttribute('class', y < lit ? (x === series.length - 1 ? 'on today' : 'on') : 'off')
      svg.append(c)
    }
  })
  return svg
}

const big = (value, unit, label) => el('div', { class: 'stat' },
  el('p', { class: 'dot-number stat-num' }, el('span', { text: String(value) }), unit ? el('span', { class: 'dot-unit', text: unit }) : null),
  el('p', { class: 'stat-label', text: label }))

export function openStats({ finishedThisYear = 0, finishedTotal = 0 } = {}) {
  const s = summary()
  const year = new Date().getFullYear()
  $('#stats-body').replaceChildren(
    el('div', { class: 'stats-grid' },
      big(s.streak, s.streak === 1 ? 'day' : 'days', 'Reading streak'),
      big(Math.round(s.today / 60), 'min', 'Today'),
      big(finishedThisYear, '', `Finished in ${year}`)),
    el('section', { class: 'stats-block' },
      el('h3', { text: 'Last 4 weeks' }),
      chart(s.series),
      el('p', { class: 'setting-note', text: 'One column per day, today on the right. A full column is your best day.' })),
    el('ul', { class: 'stats-list' },
      el('li', {}, el('span', { text: 'This week' }), el('strong', { text: formatDuration(s.week) })),
      el('li', {}, el('span', { text: 'All time' }), el('strong', { text: formatDuration(s.total) })),
      el('li', {}, el('span', { text: 'Longest streak' }), el('strong', { text: `${s.best} ${s.best === 1 ? 'day' : 'days'}` })),
      el('li', {}, el('span', { text: 'Books finished' }), el('strong', { text: String(finishedTotal) }))),
    el('p', { class: 'setting-note', text: s.tracked ? 'Reading time is counted on this device while a book is open.' : 'Reading time is counted from now on, on this device, while a book is open.' }))
  showSheet('sheet-stats')
}
