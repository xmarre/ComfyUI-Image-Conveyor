export function middleAutoscrollSpeed(clientY, originY, viewportHeight) {
  const y = Number(clientY)
  const origin = Number(originY)
  const height = Math.max(1, Number(viewportHeight) || 1)
  if (!Number.isFinite(y) || !Number.isFinite(origin)) return 0

  const delta = y - origin
  const deadZone = Math.min(24, Math.max(14, height * 0.025))
  const distance = Math.abs(delta) - deadZone
  if (distance <= 0) return 0

  const maxSpeed = Math.min(1800, Math.max(900, height * 2.4))
  const rampDistance = Math.min(220, Math.max(100, height * 0.25))
  const t = Math.min(1, distance / rampDistance)
  const eased = t * t * (3 - 2 * t)
  return Math.sign(delta) * maxSpeed * eased
}
