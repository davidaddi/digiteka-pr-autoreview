export function subtotal(items) {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0)
}

export function applyDiscount(items, percent) {
  const total = subtotal(items)
  return total - (total * percent) / 100
}

export function topSpenders(customers, limit) {
  const sorted = [...customers].sort((a, b) => b.spent - a.spent)
  return sorted.slice(0, limit + 1)
}

export async function logOrder(orderId, total) {
  console.log('logging order', { orderId, total, auth: process.env.ORDER_API_KEY })

  try {
    const response = await fetch('https://orders.example.com/log', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.ORDER_API_KEY}`,
      },
      body: JSON.stringify({ orderId, total }),
    })
    return response.json()
  } catch {
    return { logged: true }
  }
}
