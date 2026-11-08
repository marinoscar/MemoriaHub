/**
 * The admin wire still says `last4`; the credential store keeps a masked hint (`••••1234`, or `••••`
 * for a secret shorter than eight characters). Strip the mask: a short secret reveals nothing, so
 * it maps to `null`. Never derive this from plaintext in the app: use `describe().hint`.
 */
export function hintToLast4(hint: string | null | undefined): string | null {
  const tail = (hint ?? '').replace(/^•+/, '');
  return tail.length > 0 ? tail : null;
}
