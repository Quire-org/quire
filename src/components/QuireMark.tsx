/**
 * Quire's mark at the size of text, in its colour: the app icon's small cut
 * (src/assets/app-icon-small.svg): the top sheet with its window, its corner turned over, the next
 * sheet's corner beneath. Drawn edge to edge, so it can stand in for a letter.
 */
export function QuireMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="42 42 172 172" aria-hidden="true" focusable="false">
      <path fill="currentColor" fillOpacity={0.7} d="M214 158V214H158Z" />
      <path fill="currentColor" fillRule="evenodd" d="M128 42A86 86 0 0 1 214 128V158L158 214H128A86 86 0 0 1 42 128A86 86 0 0 1 128 42ZM84 128a44 44 0 1 0 88 0a44 44 0 1 0 -88 0Z" />
      <path fill="currentColor" fillOpacity={0.45} d="M158 158H214L158 214Z" />
    </svg>
  );
}
