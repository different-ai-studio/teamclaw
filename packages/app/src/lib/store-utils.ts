type AsyncOptions = {
  loadingKey?: string
  errorKey?: string
  rethrow?: boolean
}

export async function withAsync<T>(
  set: (partial: Record<string, unknown>) => void,
  fn: () => Promise<T>,
  options?: AsyncOptions
): Promise<T | undefined> {
  const lk = options?.loadingKey ?? 'isLoading'
  const ek = options?.errorKey ?? 'error'
  set({ [lk]: true, [ek]: null })
  try {
    const result = await fn()
    set({ [lk]: false })
    return result
  } catch (error) {
    set({
      [ek]: error instanceof Error ? error.message : String(error),
      [lk]: false,
    })
    if (options?.rethrow) throw error
    return undefined
  }
}
