import Foundation

struct CLIArgs {
    let pdfPath: String
    let page: Int
    let language: String
}

func parseArgs() -> CLIArgs? {
    let args = CommandLine.arguments
    var pdfPath: String?
    var page: Int?
    var language = "de"

    var i = 1
    while i < args.count {
        switch args[i] {
        case "--pdf":
            i += 1
            if i < args.count { pdfPath = args[i] }
        case "--page":
            i += 1
            if i < args.count { page = Int(args[i]) }
        case "--language":
            i += 1
            if i < args.count { language = args[i] }
        case "--help":
            printUsage()
            exit(0)
        default:
            fputs("Unknown argument: \(args[i])\n", stderr)
            printUsage()
            exit(1)
        }
        i += 1
    }

    guard let pdf = pdfPath, let p = page else {
        fputs("Error: --pdf and --page are required\n", stderr)
        printUsage()
        return nil
    }

    return CLIArgs(pdfPath: pdf, page: p, language: language)
}

func printUsage() {
    fputs("""
    Usage: vision-ocr --pdf <path> --page <number> [--language <code>]

    Arguments:
      --pdf       Path to the PDF file
      --page      Page number (1-based)
      --language  Language hint for OCR (default: de)
      --help      Show this help message

    Output: JSON to stdout with recognized text
    """, stderr)
}

guard let args = parseArgs() else {
    exit(1)
}

let processor = VisionOCRProcessor()

do {
    let result = try processor.processPage(pdfPath: args.pdfPath, pageNumber: args.page, language: args.language)

    let output: [String: Any] = [
        "text": result.text,
        "confidence": result.confidence,
        "language": args.language,
        "pageNumber": args.page
    ]

    let jsonData = try JSONSerialization.data(withJSONObject: output, options: [])
    if let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    }
} catch {
    fputs("Error: \(error.localizedDescription)\n", stderr)
    exit(3)
}
