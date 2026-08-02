export function handleProjectComposerKeyDown(event) {
  if (event.key !== "Enter") return;

  const nativeEvent = event.nativeEvent ?? event;
  if (nativeEvent.isComposing || nativeEvent.keyCode === 229) return;
  if (event.shiftKey) return;

  event.preventDefault();
  if (event.repeat) return;
  event.currentTarget.form?.requestSubmit();
}
