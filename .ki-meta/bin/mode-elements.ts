/** Validate and deterministically plan skill-local AUDIT / CONFORM elements. */

export const MODE_ELEMENT_PHASES = ['prepare', 'inspect', 'write', 'project', 'normalise'] as const
export type ModeElementPhase = (typeof MODE_ELEMENT_PHASES)[number]
export type ModeElementMode = 'audit' | 'conform'

export type ModeElement = {
  id: string
  mode: ModeElementMode
  phase: ModeElementPhase
  entry: string
  before?: string[]
  after?: string[]
  reads: string[]
  writes: string[]
}

export type ModeElements = { version: 1; elements: ModeElement[] }

const ID = /^[a-z][a-z0-9-]*$/
const REFERENCE = /^(?:(ki-[a-z0-9-]+)\/)?([a-z][a-z0-9-]*)$/
const ENTRY = /^scripts\/[a-z][a-z0-9-]*\.ts$/

export function elementKey(skill: string, id: string): string {
  return `${skill}/${id}`
}

function referenceKey(skill: string, reference: string): string | null {
  const match = reference.match(REFERENCE)
  if (!match) return null
  return elementKey(match[1] ?? skill, match[2] as string)
}

function hasPath(edges: ReadonlyMap<string, ReadonlySet<string>>, from: string, to: string): boolean {
  const pending = [from]
  const visited = new Set<string>()
  while (pending.length) {
    const current = pending.pop() as string
    if (current === to) return true
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of edges.get(current) ?? []) pending.push(next)
  }
  return false
}

export function validateModeElements(skill: string, declaration: unknown): string[] {
  const errors: string[] = []
  if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) return ['declaration must be an object']
  const record = declaration as Record<string, unknown>
  if (record.version !== 1) errors.push('version must be 1')
  if (!Array.isArray(record.elements) || record.elements.length === 0) return [...errors, 'elements must be a non-empty array']
  const ids = new Set<string>()
  for (const [index, candidate] of record.elements.entries()) {
    const label = `elements[${index}]`
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      errors.push(`${label} must be an object`)
      continue
    }
    const element = candidate as Record<string, unknown>
    if (typeof element.id !== 'string' || !ID.test(element.id)) errors.push(`${label}.id must be a kebab-case identifier`)
    else if (element.mode === 'audit' || element.mode === 'conform') {
      const key = `${element.mode}/${element.id}`
      if (ids.has(key)) errors.push(`duplicate ${element.mode} element id: ${element.id}`)
      else ids.add(key)
    }
    if (element.mode !== 'audit' && element.mode !== 'conform') errors.push(`${label}.mode must be audit or conform`)
    if (typeof element.phase !== 'string' || !MODE_ELEMENT_PHASES.includes(element.phase as ModeElementPhase))
      errors.push(`${label}.phase is unknown`)
    if (typeof element.entry !== 'string' || !ENTRY.test(element.entry)) errors.push(`${label}.entry must name a local scripts/*.ts file`)
    for (const field of ['reads', 'writes'] as const) {
      if (!Array.isArray(element[field]) || element[field].some((value) => typeof value !== 'string' || value.length === 0))
        errors.push(`${label}.${field} must be an array of non-empty scopes`)
    }
    for (const field of ['before', 'after'] as const) {
      if (
        element[field] !== undefined &&
        (!Array.isArray(element[field]) || element[field].some((value) => typeof value !== 'string' || !referenceKey(skill, value)))
      )
        errors.push(`${label}.${field} contains an invalid element reference`)
    }
  }
  return errors
}

export function planModeElements(
  skills: Record<string, ModeElements>,
  mode: ModeElementMode
): { order: Array<{ skill: string; element: ModeElement }>; errors: string[] } {
  const errors: string[] = []
  const nodes = new Map<string, { skill: string; element: ModeElement }>()
  for (const [skill, declaration] of Object.entries(skills)) {
    errors.push(...validateModeElements(skill, declaration).map((error) => `${skill}: ${error}`))
    for (const element of declaration.elements.filter((candidate) => candidate.mode === mode)) {
      const key = elementKey(skill, element.id)
      if (nodes.has(key)) errors.push(`duplicate qualified element: ${key}`)
      else nodes.set(key, { skill, element })
    }
  }
  if (errors.length) return { order: [], errors: [...new Set(errors)].sort() }

  const edges = new Map<string, Set<string>>([...nodes.keys()].map((key) => [key, new Set<string>()]))
  const addEdge = (from: string, to: string): void => {
    const source = nodes.get(from)
    const destination = nodes.get(to)
    if (!source || !destination) {
      errors.push(`unknown element reference: ${!source ? from : to}`)
      return
    }
    const sourcePhase = MODE_ELEMENT_PHASES.indexOf(source.element.phase)
    const destinationPhase = MODE_ELEMENT_PHASES.indexOf(destination.element.phase)
    if (sourcePhase > destinationPhase) errors.push(`phase violation: ${from} cannot precede ${to}`)
    edges.get(from)?.add(to)
  }
  for (const [key, node] of nodes) {
    for (const reference of node.element.before ?? []) {
      const target = referenceKey(node.skill, reference)
      if (target) addEdge(key, target)
    }
    for (const reference of node.element.after ?? []) {
      const source = referenceKey(node.skill, reference)
      if (source) addEdge(source, key)
    }
  }
  const writers = new Map<string, string[]>()
  for (const [key, node] of nodes) {
    for (const scope of node.element.writes) writers.set(scope, [...(writers.get(scope) ?? []), key])
  }
  for (const [scope, keys] of writers) {
    for (let left = 0; left < keys.length; left++) {
      for (let right = left + 1; right < keys.length; right++) {
        const first = keys[left] as string
        const second = keys[right] as string
        if (!hasPath(edges, first, second) && !hasPath(edges, second, first))
          errors.push(`undeclared write collision: ${scope} (${first}, ${second})`)
      }
    }
  }
  if (errors.length) return { order: [], errors: [...new Set(errors)].sort() }

  const indegree = new Map<string, number>([...nodes.keys()].map((key) => [key, 0]))
  for (const targets of edges.values()) for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1)
  const ready = [...nodes.keys()].filter((key) => indegree.get(key) === 0)
  const compare = (left: string, right: string): number => {
    const a = nodes.get(left) as { skill: string; element: ModeElement }
    const b = nodes.get(right) as { skill: string; element: ModeElement }
    return MODE_ELEMENT_PHASES.indexOf(a.element.phase) - MODE_ELEMENT_PHASES.indexOf(b.element.phase) || left.localeCompare(right)
  }
  const order: Array<{ skill: string; element: ModeElement }> = []
  while (ready.length) {
    ready.sort(compare)
    const key = ready.shift() as string
    order.push(nodes.get(key) as { skill: string; element: ModeElement })
    for (const target of edges.get(key) ?? []) {
      const next = (indegree.get(target) ?? 1) - 1
      indegree.set(target, next)
      if (next === 0) ready.push(target)
    }
  }
  if (order.length !== nodes.size) return { order: [], errors: ['mode-element dependency cycle'] }
  return { order, errors: [] }
}
