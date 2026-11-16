// Only app routes can be handed to the new renderer. Never load a supplied URL.
export function incognitoRoute(value: unknown): string {
  if (typeof value !== 'string' || value.length > 4096 ||
      !/^\/(?:$|(?:search|watch|channel|collection|music)(?:[/?#]|$))/.test(value) ||
      /[\\\\\r\n\x00]/.test(value)) return '/'
  return value
}

