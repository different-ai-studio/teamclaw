import { ExternalLink, FileText } from 'lucide-react'

interface SearchResultsProps {
  data: unknown
}

export function SearchResults({ data }: SearchResultsProps) {
  // Mock search results for now
  const mockResults = [
    {
      title: '2024 Climbing Industry Report',
      url: 'https://example.com/report1',
      snippet: 'Aug 29, 2025 — Statistics: The number of climbing gyms reached 811 in 2024, a 27.5% increase year-over-year...',
    },
    {
      title: 'Climbing Industry Development Report (2024)',
      url: 'https://example.com/report2',
      snippet: 'In 2024, the climbing market continued to expand, with rapid growth in the number of gyms. As of January 2025...',
    },
    {
      title: '2024 Climbing Industry Overview',
      url: 'https://example.com/report3',
      snippet: 'Dec 28, 2025 — As of early 2025, there are 811 climbing gyms nationwide, a 27.5% increase year-over-year...',
    },
  ]

  const toolCall = data as { arguments?: { query?: string } }
  const query = toolCall?.arguments?.query || 'Search query'

  return (
    <div className="p-4">
      {/* Query Display */}
      <div className="mb-4">
        <label className="text-xs text-text-muted">Search Query</label>
        <div className="mt-1 p-2 bg-bg-tertiary rounded-md text-sm">
          {query}
        </div>
      </div>

      {/* Results */}
      <div className="space-y-3">
        <label className="text-xs text-text-muted">Results ({mockResults.length})</label>
        {mockResults.map((result, index) => (
          <a
            key={index}
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block p-3 bg-bg-tertiary rounded-lg hover:bg-bg-primary transition-colors group"
          >
            <div className="flex items-start gap-2">
              <FileText size={16} className="text-accent-blue shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1">
                  <span className="text-sm font-medium truncate group-hover:text-accent-blue">
                    {result.title}
                  </span>
                  <ExternalLink size={12} className="text-text-muted opacity-0 group-hover:opacity-100" />
                </div>
                <p className="text-xs text-text-secondary mt-1 line-clamp-2">
                  {result.snippet}
                </p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  )
}
