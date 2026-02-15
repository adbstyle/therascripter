import Foundation
import Vision
import PDFKit

struct OCRResult {
    let text: String
    let confidence: Double
}

final class VisionOCRProcessor {
    func processPage(pdfPath: String, pageNumber: Int, language: String) throws -> OCRResult {
        let url = URL(fileURLWithPath: pdfPath)
        guard let document = PDFDocument(url: url) else {
            throw OCRError.cannotOpenPDF(pdfPath)
        }

        // PDFKit uses 0-based indexing, CLI uses 1-based
        let pageIndex = pageNumber - 1
        guard pageIndex >= 0, pageIndex < document.pageCount else {
            throw OCRError.invalidPageNumber(pageNumber, total: document.pageCount)
        }

        guard let page = document.page(at: pageIndex) else {
            throw OCRError.cannotLoadPage(pageNumber)
        }

        let image = try renderPageToImage(page: page)
        return try recognizeText(image: image, language: language)
    }

    private func renderPageToImage(page: PDFPage) throws -> CGImage {
        // Render at 300 DPI for good OCR quality
        let pageRect = page.bounds(for: .mediaBox)
        let scale: CGFloat = 300.0 / 72.0 // PDF is 72 DPI
        let width = Int(pageRect.width * scale)
        let height = Int(pageRect.height * scale)

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
        ) else {
            throw OCRError.renderFailed
        }

        context.setFillColor(CGColor.white)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)

        guard let image = context.makeImage() else {
            throw OCRError.renderFailed
        }

        return image
    }

    private func recognizeText(image: CGImage, language: String) throws -> OCRResult {
        let semaphore = DispatchSemaphore(value: 0)
        var recognizedTexts: [String] = []
        var totalConfidence: Double = 0
        var observationCount = 0
        var recognitionError: Error?

        let request = VNRecognizeTextRequest { request, error in
            if let error = error {
                recognitionError = error
                semaphore.signal()
                return
            }

            guard let observations = request.results as? [VNRecognizedTextObservation] else {
                semaphore.signal()
                return
            }

            for observation in observations {
                guard let candidate = observation.topCandidates(1).first else { continue }
                recognizedTexts.append(candidate.string)
                totalConfidence += Double(candidate.confidence)
                observationCount += 1
            }

            semaphore.signal()
        }

        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        // Map language code to Vision language
        let visionLanguage = mapLanguage(language)
        request.recognitionLanguages = [visionLanguage, "en"]

        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        try handler.perform([request])

        semaphore.wait()

        if let error = recognitionError {
            throw error
        }

        let text = recognizedTexts.joined(separator: "\n")
        let avgConfidence = observationCount > 0 ? totalConfidence / Double(observationCount) : 0

        return OCRResult(text: text, confidence: avgConfidence)
    }

    private func mapLanguage(_ code: String) -> String {
        switch code {
        case "de": return "de-DE"
        case "en": return "en-US"
        case "fr": return "fr-FR"
        case "it": return "it-IT"
        default: return code
        }
    }
}

enum OCRError: LocalizedError {
    case cannotOpenPDF(String)
    case invalidPageNumber(Int, total: Int)
    case cannotLoadPage(Int)
    case renderFailed

    var errorDescription: String? {
        switch self {
        case .cannotOpenPDF(let path):
            return "PDF kann nicht geöffnet werden: \(path)"
        case .invalidPageNumber(let page, let total):
            return "Ungültige Seitennummer \(page) (PDF hat \(total) Seiten)"
        case .cannotLoadPage(let page):
            return "Seite \(page) kann nicht geladen werden"
        case .renderFailed:
            return "Seite konnte nicht gerendert werden"
        }
    }
}
