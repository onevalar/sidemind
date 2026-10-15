/**
 * Browser-side preferences live under `sidemind.*`. Canvas Note stored them as `canvas.*`; a value found there is used
 * until the new key has been written, so switching to Sidemind keeps theme, layout and the open conversation.
 */
const key = (name: string) => 'sidemind.' + name
const legacy = (name: string) => 'canvas.' + name

export const prefs = {
  get: (name: string): string | null => localStorage.getItem(key(name)) ?? localStorage.getItem(legacy(name)),
  set: (name: string, value: string) => localStorage.setItem(key(name), value),
  remove: (name: string) => { localStorage.removeItem(key(name)); localStorage.removeItem(legacy(name)) },
}
