import Foundation
import Speech

/// One JSON line in, one JSON line out — used by Electron main for Apple STT/TTS.
@main
enum YaaiaVoipHelper {
    static func main() async {
        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let cmd = obj["cmd"] as? String
            else {
                emit(["ok": false, "error": "invalid json"] as [String: Any])
                continue
            }
            switch cmd {
            case "stt":
                guard let audioPath = obj["audioPath"] as? String else {
                    emit(["ok": false, "error": "audioPath required"] as [String: Any])
                    continue
                }
                do {
                    let text = try await transcribeFile(path: audioPath)
                    emit(["ok": true, "text": text] as [String: Any])
                } catch {
                    emit(["ok": false, "error": error.localizedDescription] as [String: Any])
                }
            case "tts":
                guard let text = obj["text"] as? String, let outPath = obj["outPath"] as? String else {
                    emit(["ok": false, "error": "text and outPath required"] as [String: Any])
                    continue
                }
                do {
                    try speakToFile(text: text, outPath: outPath)
                    emit(["ok": true, "outPath": outPath] as [String: Any])
                } catch {
                    emit(["ok": false, "error": error.localizedDescription] as [String: Any])
                }
            default:
                emit(["ok": false, "error": "unknown cmd"] as [String: Any])
            }
        }
    }

    private static func emit(_ dict: [String: Any]) {
        if let d = try? JSONSerialization.data(withJSONObject: dict),
           let s = String(data: d, encoding: .utf8)
        {
            print(s)
            fflush(stdout)
        }
    }

    private static func transcribeFile(path: String) async throws -> String {
        let ok = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status == .authorized)
            }
        }
        guard ok else {
            throw NSError(
                domain: "yaaia-voip",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition not authorized (System Settings → Privacy)"]
            )
        }
        let url = URL(fileURLWithPath: path)
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")), recognizer.isAvailable else {
            throw NSError(domain: "yaaia-voip", code: 2, userInfo: [NSLocalizedDescriptionKey: "SFSpeechRecognizer unavailable"])
        }
        let request = SFSpeechURLRecognitionRequest(url: url)
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<String, Error>) in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                if finished { return }
                if let error {
                    finished = true
                    cont.resume(throwing: error)
                    return
                }
                guard let result else { return }
                if result.isFinal {
                    finished = true
                    cont.resume(returning: result.bestTranscription.formattedString)
                }
            }
        }
    }

    /// Apple TTS via `/usr/bin/say` (same engine as many system voices).
    private static func speakToFile(text: String, outPath: String) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        p.arguments = ["-o", outPath, text]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw NSError(
                domain: "yaaia-voip",
                code: 3,
                userInfo: [NSLocalizedDescriptionKey: "say exited with status \(p.terminationStatus)"]
            )
        }
    }
}
