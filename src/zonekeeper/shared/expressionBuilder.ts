export const EXPRESSION_FIELDS = [
  { id: 'http.host', label: 'Hostname', kind: 'text' },
  { id: 'http.request.uri.path', label: 'URI path', kind: 'text' },
  { id: 'http.request.uri.query', label: 'Query string', kind: 'text' },
  { id: 'http.request.full_uri', label: 'Full URI', kind: 'text' },
  { id: 'http.request.method', label: 'Method', kind: 'text' },
  { id: 'http.user_agent', label: 'User agent', kind: 'text' },
  { id: 'http.referer', label: 'Referer', kind: 'text' },
  { id: 'ip.src.country', label: 'Country', kind: 'text' },
  { id: 'ip.src', label: 'IP address', kind: 'ip' },
  { id: 'ip.src.asnum', label: 'AS number', kind: 'number' }
] as const

export const EXPRESSION_OPERATORS = [
  { id: 'eq', label: 'equals', kinds: ['text', 'ip', 'number'] },
  { id: 'ne', label: 'does not equal', kinds: ['text', 'ip', 'number'] },
  { id: 'contains', label: 'contains', kinds: ['text'] },
  { id: 'not_contains', label: 'does not contain', kinds: ['text'] },
  { id: 'starts_with', label: 'starts with', kinds: ['text'] },
  { id: 'ends_with', label: 'ends with', kinds: ['text'] },
  { id: 'in', label: 'is one of', kinds: ['text', 'ip', 'number'] }
] as const

export type ExpressionOperator = (typeof EXPRESSION_OPERATORS)[number]['id']
export type ExpressionJoin = 'and' | 'or'

export interface ExpressionCondition {
  field: string
  operator: ExpressionOperator
  value: string
  /** Ignored on the first condition. */
  join: ExpressionJoin
}

const kindOf = (field: string): string => EXPRESSION_FIELDS.find((f) => f.id === field)?.kind ?? 'text'
const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const unquote = (s: string): string => s.slice(1, -1).replace(/\\(.)/g, '$1')
const literal = (field: string, v: string): string => (kindOf(field) === 'text' ? quote(v) : v)

function conditionText({ field, operator, value }: ExpressionCondition): string {
  const v = value.trim()
  switch (operator) {
    case 'eq':
    case 'ne':
    case 'contains':
      return `${field} ${operator} ${literal(field, v)}`
    case 'not_contains':
      return `not ${field} contains ${quote(v)}`
    case 'starts_with':
    case 'ends_with':
      return `${operator}(${field}, ${quote(v)})`
    case 'in':
      return `${field} in {${v.split(/[\s,]+/).filter(Boolean).map((x) => literal(field, x)).join(' ')}}`
  }
}

/** `and` binds tighter than `or`. */
export function buildExpression(conditions: ExpressionCondition[]): string {
  return conditions
    .filter((c) => c.value.trim() !== '')
    .map((c, i) => (i === 0 ? conditionText(c) : `${c.join} ${conditionText(c)}`))
    .join(' ')
}

const VALUE = String.raw`"(?:[^"\\]|\\.)*"|[^\s()"{}]+`
const FIELD = String.raw`[a-z_.]+`
type Parsed = Omit<ExpressionCondition, 'join'>
const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Parsed]> = [
  [new RegExp(`^not (${FIELD}) contains ("(?:[^"\\\\]|\\\\.)*")$`), (m) => ({ field: m[1]!, operator: 'not_contains', value: unquote(m[2]!) })],
  [new RegExp(`^(${FIELD}) (eq|ne|contains) (${VALUE})$`), (m) => ({ field: m[1]!, operator: m[2] as ExpressionOperator, value: m[3]!.startsWith('"') ? unquote(m[3]!) : m[3]! })],
  [new RegExp(`^(starts_with|ends_with)\\((${FIELD}), ("(?:[^"\\\\]|\\\\.)*")\\)$`), (m) => ({ field: m[2]!, operator: m[1] as ExpressionOperator, value: unquote(m[3]!) })],
  [new RegExp(`^(${FIELD}) in \\{([^{}]*)\\}$`), (m) => ({ field: m[1]!, operator: 'in', value: (m[2]!.match(new RegExp(VALUE, 'g')) ?? []).map((x) => (x.startsWith('"') ? unquote(x) : x)).join(' ') })]
]

function splitTop(expr: string): Array<{ text: string; join: ExpressionJoin }> {
  const parts: Array<{ text: string; join: ExpressionJoin }> = []
  let join: ExpressionJoin = 'and'
  let depth = 0
  let inString = false
  let start = 0
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '(' || c === '{') depth++
    else if (c === ')' || c === '}') depth--
    else if (depth === 0) {
      const word = expr.startsWith(' and ', i) ? 'and' : expr.startsWith(' or ', i) ? 'or' : null
      if (word) {
        parts.push({ text: expr.slice(start, i), join })
        join = word
        i += word.length + 1
        start = i + 1
      }
    }
  }
  parts.push({ text: expr.slice(start), join })
  return parts
}

/** Line breaks and runs of spaces become one space, strings are left alone. */
function normalise(expr: string): string {
  let out = ''
  let inString = false
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i] as string
    if (inString) {
      out += c
      if (c === '\\' && i + 1 < expr.length) out += expr[++i]
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
      out += c
    } else if (/\s/.test(c)) {
      if (!out.endsWith(' ')) out += ' '
    } else out += c
  }
  return out.trim()
}

/** `(a eq "b")` to `a eq "b"`, only when the brackets wrap the whole part. */
function unwrap(part: string): string {
  let s = part.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let inString = false
    let closes = -1
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
      } else if (c === '"') inString = true
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) {
        closes = i
        break
      }
    }
    if (closes !== s.length - 1) break
    s = s.slice(1, -1).trim()
  }
  return s
}

/** Null if the builder can't show it exactly. */
export function parseExpression(expression: string): ExpressionCondition[] | null {
  const text = normalise(expression)
  if (text === '') return []
  const conditions: ExpressionCondition[] = []
  const plain: string[] = []
  for (const part of splitTop(text)) {
    const inner = unwrap(part.text)
    const hit = PATTERNS.map(([re, make]) => {
      const m = inner.match(re)
      return m ? make(m) : null
    }).find(Boolean)
    if (!hit || !EXPRESSION_FIELDS.some((f) => f.id === hit.field)) return null
    conditions.push({ ...hit, join: part.join })
    plain.push(plain.length === 0 ? inner : `${part.join} ${inner}`)
  }
  // A group like (a or b) never matches one condition, so meaning is kept
  return buildExpression(conditions) === plain.join(' ') ? conditions : null
}
