export function Log(title: string, message?: any) {
  if (!message) {
    console.log(title)
  } else if (Array.isArray(message) || typeof message === 'object') {
    console.log(`Log: ${title} ${JSON.stringify(message)}`)
  } else {
    console.log(`Log: ${title} ${message}`)
  }
}
