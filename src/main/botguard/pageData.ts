import { parse, type Expression, type Node } from 'acorn'
import { simple } from 'acorn-walk'

type Data = null | string | boolean | number | Data[] | { [key: string]: Data }

function literalData(node: Node): Data {
  const expression = node as Expression
  switch (expression.type) {
    case 'Literal':
      if (expression.value === null || ['string', 'boolean', 'number'].includes(typeof expression.value)) {
        return expression.value as null | string | boolean | number
      }
      break
    case 'ArrayExpression':
      return expression.elements.map((item) => {
        if (!item) return null
        return literalData(item)
      })
    case 'ObjectExpression':
      return Object.fromEntries(expression.properties.map((property) => {
        if (property.type !== 'Property' || property.computed || property.method || property.kind !== 'init') {
          throw new Error('Non-data property in YouTube page configuration')
        }
        const key = property.key.type === 'Identifier' ? property.key.name : literalData(property.key)
        if (typeof key !== 'string' && typeof key !== 'number') throw new Error('Invalid page data key')
        return [String(key), literalData(property.value)]
      }))
    case 'UnaryExpression': {
      const value = literalData(expression.argument)
      if (typeof value === 'number' && expression.operator === '-') return -value
      if (typeof value === 'number' && expression.operator === '+') return value
      break
    }
  }
  throw new Error(`Unsupported executable expression in page data: ${node.type}`)
}

function memberPath(expression: Expression): string | null {
  if (expression.type === 'Identifier') return expression.name
  if (expression.type !== 'MemberExpression' || expression.object.type === 'Super') return null
  const parent = memberPath(expression.object)
  const property = expression.computed && expression.property.type === 'Literal' ? expression.property.value :
    !expression.computed && expression.property.type === 'Identifier' ? expression.property.name : null
  return parent && typeof property === 'string' ? `${parent}.${property}` : null
}

/** Read the public watch page response as inert data, never executable script. */
export function extractInitialPlayerResponse(source: string): Record<string, Data> | null {
  if (!source.includes('ytInitialPlayerResponse')) return null
  let program: ReturnType<typeof parse>
  try { program = parse(source, { ecmaVersion: 'latest' }) } catch { return null }
  let response: Record<string, Data> | null = null
  const read = (node: Node) => {
    const value = literalData(node)
    if (value && typeof value === 'object' && !Array.isArray(value)) response = value
  }
  simple(program, {
    VariableDeclarator(node) {
      if (node.id.type === 'Identifier' && node.id.name === 'ytInitialPlayerResponse' && node.init) read(node.init)
    },
    AssignmentExpression(node) {
      if (node.left.type === 'MemberExpression' || node.left.type === 'Identifier') {
        const path = memberPath(node.left)
        if (path === 'ytInitialPlayerResponse' || path === 'window.ytInitialPlayerResponse') read(node.right)
      }
    }
  })
  return response
}

export function extractYouTubePageData(html: string): { config: Record<string, Data>; attestation: Record<string, Data>; playerResponse?: Record<string, Data> } {
  // DOMParser keeps page scripts inert. Acorn reads call arguments as data;
  // neither the downloaded page nor its configuration is evaluated as code.
  const document = new DOMParser().parseFromString(html, 'text/html')
  const config: Record<string, Data> = Object.create(null)
  let attestation: Record<string, Data> | null = null
  let playerResponse: Record<string, Data> | undefined
  for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
    const source = script.textContent ?? ''
    const player = extractInitialPlayerResponse(source)
    if (player) playerResponse = player
    if (!source.includes('ytcfg') && !source.includes('ytAtN')) continue
    let program: ReturnType<typeof parse>
    try {
      program = parse(source, { ecmaVersion: 'latest', sourceType: script.getAttribute('type') === 'module' ? 'module' : 'script' })
    } catch {
      // Unrelated inline code may use unsupported syntax. Required data still
      // has to be found and validated below; no regex/eval fallback is used.
      continue
    }
    simple(program, {
      CallExpression(call) {
        if (call.callee.type === 'Super') return
        const path = memberPath(call.callee)
        const isConfig = path === 'ytcfg.set' || path === 'window.ytcfg.set'
        const isAttestation = path === 'window.ytAtN' || path === 'ytAtN'
        if ((!isConfig && !isAttestation) || call.arguments[0]?.type !== 'ObjectExpression') return
        const value = literalData(call.arguments[0])
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        if (isConfig) Object.assign(config, value)
        else attestation = value
      }
    })
  }
  if (!Object.keys(config).length) throw new Error('YouTube page has no supported configuration data')
  if (!attestation) throw new Error('YouTube page has no supported attestation data')
  return { config, attestation, playerResponse }
}
