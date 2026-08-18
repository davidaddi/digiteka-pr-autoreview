export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function applyDiscount(items, percent) {
  const total = subtotal(items)
  return total - (total * percent) / 100
}

export async function logOrder(orderId, total) {
  const response = await fetch('https://orders.example.com/log', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ orderId, total }),
  })
  if (!response.ok) {
    throw new Error(`order log failed: ${response.status}`)
  }
  return response.json()
}
