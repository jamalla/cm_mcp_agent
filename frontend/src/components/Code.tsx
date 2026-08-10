import { useMemo } from 'react'

/**
 * A small dependency-free highlighter.
 *
 * A full Prism/Shiki bundle is a lot of weight for two languages in a demo, and
 * the generated code we display is machine-written and predictable.
 */

const PY_KEYWORDS =
  /\b(import|from|def|class|return|if|elif|else|for|while|try|except|finally|raise|with|as|in|not|and|or|is|None|True|False|pass|lambda|yield|global|await|async)\b/g

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function highlightPython(source: string): string {
  const out: string[] = []
  // Split on strings and comments first so keywords inside them stay plain.
  const parts = source.split(/("""[\s\S]*?"""|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|#[^\n]*)/g)

  parts.forEach((part, index) => {
    if (!part) return
    if (index % 2 === 1) {
      const cls = part.startsWith('#') ? 'tok-comment' : 'tok-string'
      out.push(`<span class="${cls}">${escapeHtml(part)}</span>`)
      return
    }
    let escaped = escapeHtml(part)
    escaped = escaped.replace(PY_KEYWORDS, '<span class="tok-key">$1</span>')
    escaped = escaped.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-num">$1</span>')
    escaped = escaped.replace(
      /\b([A-Z][A-Z0-9_]{2,})\b/g,
      '<span class="tok-const">$1</span>',
    )
    out.push(escaped)
  })
  return out.join('')
}

function highlightJson(source: string): string {
  return escapeHtml(source)
    .replace(/("(?:[^"\\]|\\.)*")(\s*:)/g, '<span class="tok-prop">$1</span>$2')
    .replace(/:(\s*)("(?:[^"\\]|\\.)*")/g, ':$1<span class="tok-string">$2</span>')
    .replace(/\b(true|false|null)\b/g, '<span class="tok-key">$1</span>')
    .replace(/:(\s*)(-?\d+(?:\.\d+)?)/g, ':$1<span class="tok-num">$2</span>')
}

interface Props {
  code: string
  language: 'python' | 'json'
  maxHeight?: number
}

export function Code({ code, language, maxHeight = 340 }: Props) {
  const html = useMemo(
    () => (language === 'python' ? highlightPython(code) : highlightJson(code)),
    [code, language],
  )
  return (
    <pre className="code" style={{ maxHeight }}>
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  )
}
