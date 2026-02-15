export interface PageData {
  pageNumber: number
  contentType: 'text' | 'scanned'
  text: string
}

export interface ExtractionResult {
  pages: PageData[]
  metadata: {
    totalPages: number
    title?: string
    author?: string
  }
}
