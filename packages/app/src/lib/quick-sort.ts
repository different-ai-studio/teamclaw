export function quickSort<T>(arr: T[], compareFn?: (a: T, b: T) => number): T[] {
  if (arr.length <= 1) {
    return arr
  }

  const compare = compareFn ?? ((a: T, b: T) => {
    if (a < b) return -1
    if (a > b) return 1
    return 0
  })

  const pivot = arr[arr.length - 1]
  const left: T[] = []
  const right: T[] = []

  for (let i = 0; i < arr.length - 1; i++) {
    if (compare(arr[i], pivot) < 0) {
      left.push(arr[i])
    } else {
      right.push(arr[i])
    }
  }

  return [...quickSort(left, compare), pivot, ...quickSort(right, compare)]
}
