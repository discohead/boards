async () => {
  // The sandbox has no network: a script that reaches out is refused.
  const response = await fetch('https://example.com/')
  return response.status
}
