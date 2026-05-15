import AVFoundation
import AppKit
import Foundation
import Speech

struct HelperOutput: Encodable {
    let ok: Bool
    let engine: String
    let locale: String
    let text: String?
    let error: String?
    let locales: [String]?
    let authorization: String?
    let path: String?
}

enum HelperError: Error, CustomStringConvertible {
    case badArguments
    case unsupportedOS
    case localeNotSupported(String)
    case noSupportedLocales
    case speechAuthorization(String)
    case ttsFailed(String)

    var description: String {
        switch self {
        case .badArguments:
            return "Usage: yaaia-speech-helper check <locale> | locales | synthesize-file <path> <voice> <rate> <text> | transcribe-file <path> <locale>"
        case .unsupportedOS:
            return "SpeechAnalyzer requires macOS 26 or newer."
        case .localeNotSupported(let locale):
            return "DictationTranscriber does not support locale \(locale)."
        case .noSupportedLocales:
            return "DictationTranscriber reported no supported locales. Check macOS Speech Recognition permission and language assets."
        case .speechAuthorization(let status):
            return "Speech Recognition authorization is \(status)."
        case .ttsFailed(let message):
            return "NSSpeechSynthesizer failed: \(message)"
        }
    }
}

@main
struct YAAIASpeechHelper {
    static func main() async {
        do {
            let output = try await run(arguments: CommandLine.arguments)
            write(output)
        } catch {
            write(
                HelperOutput(
                    ok: false,
                    engine: "SpeechAnalyzer/DictationTranscriber",
                    locale: "",
                    text: nil,
                    error: String(describing: error),
                    locales: nil,
                    authorization: nil,
                    path: nil
                )
            )
            Foundation.exit(1)
        }
    }

    static func run(arguments: [String]) async throws -> HelperOutput {
        guard arguments.count >= 2 else {
            throw HelperError.badArguments
        }
        if #available(macOS 26.0, *) {
            let command = arguments[1]
            if command == "locales" {
                let authorization = try await requireSpeechAuthorization()
                let supported = await DictationTranscriber.supportedLocales.map { $0.identifier(.bcp47) }.sorted()
                return HelperOutput(
                    ok: true,
                    engine: "SpeechAnalyzer/DictationTranscriber",
                    locale: "",
                    text: nil,
                    error: nil,
                    locales: supported,
                    authorization: authorization,
                    path: nil
                )
            }
            if command == "synthesize-file", arguments.count >= 6 {
                let path = arguments[2]
                let voice = arguments[3]
                let rate = Float(arguments[4]) ?? 210
                let text = arguments[5...].joined(separator: " ")
                try synthesizeFile(text: text, path: path, voice: voice, rate: rate)
                return HelperOutput(
                    ok: true,
                    engine: "NSSpeechSynthesizer",
                    locale: "",
                    text: nil,
                    error: nil,
                    locales: nil,
                    authorization: nil,
                    path: path
                )
            }
            if command == "check", arguments.count >= 3 {
                let locale = Locale(identifier: arguments[2])
                let selectedLocale = try await supportedLocale(equivalentTo: locale)
                let transcriber = makeTranscriber(locale: selectedLocale)
                try await ensureModel(transcriber: transcriber)
                return HelperOutput(
                    ok: true,
                    engine: "SpeechAnalyzer/DictationTranscriber",
                    locale: selectedLocale.identifier(.bcp47),
                    text: nil,
                    error: nil,
                    locales: nil,
                    authorization: "authorized",
                    path: nil
                )
            }
            if command == "transcribe-file", arguments.count >= 4 {
                let path = arguments[2]
                let locale = Locale(identifier: arguments[3])
                let text = try await transcribeFile(path: path, locale: locale)
                return HelperOutput(
                    ok: true,
                    engine: "SpeechAnalyzer/DictationTranscriber",
                    locale: locale.identifier(.bcp47),
                    text: text,
                    error: nil,
                    locales: nil,
                    authorization: "authorized",
                    path: nil
                )
            }
            throw HelperError.badArguments
        } else {
            throw HelperError.unsupportedOS
        }
    }

    static func write(_ output: HelperOutput) {
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(output) else {
            print("{\"ok\":false,\"engine\":\"native-macOS-speech\",\"locale\":\"\",\"error\":\"JSON encoding failed\",\"locales\":null,\"authorization\":null,\"path\":null}")
            return
        }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    @available(macOS 26.0, *)
    static func synthesizeFile(text: String, path: String, voice: String, rate: Float) throws {
        // AVSpeechSynthesizer.write hangs in this CLI helper on current macOS;
        // NSSpeechSynthesizer remains the stable native path for writing speech files.
        let output = URL(fileURLWithPath: path)
        let voiceName = resolveVoiceName(voice)
        guard let synthesizer = NSSpeechSynthesizer(voice: voiceName) else {
            throw HelperError.ttsFailed("could not create synthesizer")
        }
        if rate > 0 {
            synthesizer.rate = rate
        }
        guard synthesizer.startSpeaking(text, to: output) else {
            throw HelperError.ttsFailed("startSpeaking returned false")
        }
        while synthesizer.isSpeaking {
            RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
        }
        guard FileManager.default.fileExists(atPath: path) else {
            throw HelperError.ttsFailed("no output file was created")
        }
    }

    @available(macOS 26.0, *)
    static func resolveVoiceName(_ rawVoice: String) -> NSSpeechSynthesizer.VoiceName? {
        let requested = rawVoice.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !requested.isEmpty else {
            return nil
        }
        for voice in NSSpeechSynthesizer.availableVoices {
            if voice.rawValue.caseInsensitiveCompare(requested) == .orderedSame {
                return voice
            }
            let attributes = NSSpeechSynthesizer.attributes(forVoice: voice)
            if let name = attributes[.name] as? String,
               name.caseInsensitiveCompare(requested) == .orderedSame {
                return voice
            }
            if let identifier = attributes[.identifier] as? String,
               identifier.caseInsensitiveCompare(requested) == .orderedSame {
                return voice
            }
        }
        return NSSpeechSynthesizer.VoiceName(rawValue: requested)
    }

    @available(macOS 26.0, *)
    static func transcribeFile(path: String, locale: Locale) async throws -> String {
        let url = URL(fileURLWithPath: path)
        let file = try AVAudioFile(forReading: url)
        let selectedLocale = try await supportedLocale(equivalentTo: locale)
        let transcriber = makeTranscriber(locale: selectedLocale)
        try await ensureModel(transcriber: transcriber)

        async let transcriptionFuture = transcriber.results.reduce("") { transcript, result in
            transcript + String(result.text.characters)
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if let lastSample = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            await analyzer.cancelAndFinishNow()
        }

        return try await transcriptionFuture
    }

    @available(macOS 26.0, *)
    static func makeTranscriber(locale: Locale) -> DictationTranscriber {
        DictationTranscriber(
            locale: locale,
            contentHints: [.farField],
            transcriptionOptions: [],
            reportingOptions: [.frequentFinalization],
            attributeOptions: []
        )
    }

    @available(macOS 26.0, *)
    static func supportedLocale(equivalentTo locale: Locale) async throws -> Locale {
        _ = try await requireSpeechAuthorization()
        let requested = locale.identifier(.bcp47)
        let supported = await DictationTranscriber.supportedLocales
        guard !supported.isEmpty else {
            throw HelperError.noSupportedLocales
        }
        if let exact = supported.first(where: { $0.identifier(.bcp47) == requested }) {
            return exact
        }
        if let equivalent = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            return equivalent
        }
        if let language = locale.language.languageCode?.identifier,
           let sameLanguage = supported.first(where: { $0.language.languageCode?.identifier == language }) {
            return sameLanguage
        }
        throw HelperError.localeNotSupported(requested)
    }

    @available(macOS 26.0, *)
    static func ensureModel(transcriber: DictationTranscriber) async throws {
        let installed = await DictationTranscriber.installedLocales
        let selectedIDs = transcriber.selectedLocales.map { $0.identifier(.bcp47) }
        let installedIDs = installed.map { $0.identifier(.bcp47) }
        if selectedIDs.allSatisfy({ installedIDs.contains($0) }) {
            return
        }

        if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await request.downloadAndInstall()
        }
    }

    static func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized:
            return "authorized"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "notDetermined"
        @unknown default:
            return "unknown"
        }
    }

    static func requestAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    static func requireSpeechAuthorization() async throws -> String {
        let status = await requestAuthorization()
        guard status == .authorized else {
            throw HelperError.speechAuthorization(authorizationName(status))
        }
        return authorizationName(status)
    }
}
