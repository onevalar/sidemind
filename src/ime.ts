/**
 * True while an input method is composing text. The Enter (or Escape) that confirms or cancels a candidate must not
 * trigger send/select/close. Chrome and Firefox flag it with `isComposing`; Safari delivers that key after
 * `compositionend`, with `isComposing` already false but `keyCode` 229 ("process key"), so both are checked.
 */
export const composing = (event: KeyboardEvent | { nativeEvent: KeyboardEvent }): boolean => {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || native.keyCode === 229
}
