import CoreGraphics
import Foundation

// A PDF's pages, drawn by the system for the backend (see src/pdf.rs). The bytes stay the caller's:
// they are only read for as long as each of these calls lasts.

private func document(_ bytes: UnsafePointer<UInt8>, _ count: Int) -> CGPDFDocument? {
  let data = Data(bytesNoCopy: UnsafeMutablePointer(mutating: bytes), count: count, deallocator: .none)
  guard let provider = CGDataProvider(data: data as CFData) else { return nil }
  return CGPDFDocument(provider)
}

/// A page's size as it shows: turned, if the file says so.
private func shownSize(_ page: CGPDFPage) -> CGSize {
  let box = page.getBoxRect(.cropBox)
  return page.rotationAngle % 180 == 0 ? box.size : CGSize(width: box.height, height: box.width)
}

@_cdecl("quire_pdf_page_count")
func quirePdfPageCount(_ bytes: UnsafePointer<UInt8>, _ count: Int) -> Int {
  return document(bytes, count)?.numberOfPages ?? -1
}

@_cdecl("quire_pdf_page_size")
func quirePdfPageSize(_ bytes: UnsafePointer<UInt8>, _ count: Int, _ number: Int, _ width: UnsafeMutablePointer<Double>, _ height: UnsafeMutablePointer<Double>) -> Bool {
  guard let page = document(bytes, count)?.page(at: number) else { return false }
  let size = shownSize(page)
  width.pointee = Double(size.width)
  height.pointee = Double(size.height)
  return true
}

/// The page drawn into `pixels`, `width` × `height` of 4 bytes each, on white.
@_cdecl("quire_pdf_draw")
func quirePdfDraw(_ bytes: UnsafePointer<UInt8>, _ count: Int, _ number: Int, _ width: Int, _ height: Int, _ pixels: UnsafeMutablePointer<UInt8>) -> Bool {
  guard
    let page = document(bytes, count)?.page(at: number),
    let space = CGColorSpace(name: CGColorSpace.sRGB),
    let context = CGContext(data: pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return false }
  context.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
  context.fill(CGRect(x: 0, y: 0, width: width, height: height))
  context.interpolationQuality = .high
  let size = shownSize(page)
  // The system's transform only ever shrinks a page: it is asked for the page at its own size (which
  // brings in any turn the file gives it), and the scaling up or down is done here.
  context.scaleBy(x: CGFloat(width) / size.width, y: CGFloat(height) / size.height)
  context.concatenate(page.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: size), rotate: 0, preserveAspectRatio: true))
  context.drawPDFPage(page)
  return true
}
