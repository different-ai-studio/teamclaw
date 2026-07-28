import { createFileRoute, useRouter } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { useState } from 'react'
import { ensureSchema, sql } from '../db'

type Item = { id: string; title: string; created_at: string }

// SELECT the items table. Runs only on the server (createServerFn) and is
// invoked from the route loader during SSR.
const getItems = createServerFn({ method: 'GET' }).handler(async () => {
  await ensureSchema()
  const rows = await sql<Item[]>`
    select id, title, created_at
    from items
    order by created_at desc
    limit 50
  `
  return rows.map((r) => ({ ...r, created_at: String(r.created_at) }))
})

// INSERT a new item, then the component invalidates the router to re-run the
// loader and show the fresh list.
const addItem = createServerFn({ method: 'POST' })
  .validator((title: string) => {
    const trimmed = title.trim()
    if (!trimmed) throw new Error('title is required')
    return trimmed
  })
  .handler(async ({ data }) => {
    await ensureSchema()
    await sql`insert into items (title) values (${data})`
  })

export const Route = createFileRoute('/')({
  component: Home,
  loader: async () => await getItems(),
})

function Home() {
  const router = useRouter()
  const items = Route.useLoaderData()
  const [title, setTitle] = useState('')

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 640, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>TeamClaw App</h1>
      <p>TanStack Start (Node SSR) + Postgres. Items below are read from and written to the database.</p>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const value = title
          if (!value.trim()) return
          addItem({ data: value }).then(() => {
            setTitle('')
            router.invalidate()
          })
        }}
        style={{ display: 'flex', gap: '0.5rem', margin: '1rem 0' }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New item title"
          style={{ flex: 1, padding: '0.5rem' }}
        />
        <button type="submit" style={{ padding: '0.5rem 1rem' }}>
          Add
        </button>
      </form>

      <ul>
        {items.length === 0 ? (
          <li>No items yet — add one above.</li>
        ) : (
          items.map((item) => (
            <li key={item.id}>
              {item.title}{' '}
              <small style={{ color: '#888' }}>({item.created_at})</small>
            </li>
          ))
        )}
      </ul>
    </main>
  )
}
