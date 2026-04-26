interface TipTapNode {
  type?: string
  text?: string
  attrs?: Record<string, unknown>
  content?: TipTapNode[]
}

export function tiptapToPlainText(doc: TipTapNode | null | undefined): string {
  if (!doc || typeof doc !== 'object') return ''

  const walk = (node: TipTapNode | undefined, into: string[]): void => {
    if (!node) return
    switch (node.type) {
      case 'text':
        into.push(node.text ?? '')
        return
      case 'placeholderChip':
        into.push(String(node.attrs?.label ?? ''))
        return
      case 'speakerLabel':
      case 'timestamp':
        return
      case 'paragraph': {
        const buf: string[] = []
        for (const child of node.content ?? []) walk(child, buf)
        into.push(buf.join(''))
        return
      }
      default:
        for (const child of node.content ?? []) walk(child, into)
    }
  }

  const buf: string[] = []
  walk(doc as TipTapNode, buf)
  return buf.filter((s) => s.length > 0).join('\n')
}
