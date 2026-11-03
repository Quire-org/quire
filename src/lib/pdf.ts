/** A page of a PDF album (`…/Book.pdf#3`): drawn from the PDF by the backend, never a file of its own. */
export const isPdfPage = (item: { primary: string }) => /\.pdf#\d+$/i.test(item.primary);
