export function disableNumberInputWheelChanges() {
  document.addEventListener('wheel', (event) => {
    const input = event.target instanceof HTMLInputElement ? event.target : null
    if (input?.type === 'number' && document.activeElement === input) input.blur()
  }, { capture: true, passive: true })
}
