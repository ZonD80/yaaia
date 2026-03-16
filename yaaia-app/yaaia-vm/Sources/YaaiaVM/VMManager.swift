import AppKit
import Foundation
import Virtualization

/// Virtual display resolution. 1920×1200 (16:10) regardless of VM console window size.
private let virtualDisplayWidth: Double = 1920
private let virtualDisplayHeight: Double = 1200

enum YaaiaVMConstants {
    static var yaaiaDir: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("yaaia")
    }
    static var vmsDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("yaaia")
            .appendingPathComponent("VM")
    }
    static var isosDir: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("yaaia")
            .appendingPathComponent("ISOs")
    }
    static var debianIsoPath: URL {
        isosDir.appendingPathComponent("debian-13.3.0-arm64-netinst.iso")
    }
    static let debianIsoUrl = URL(
        string:
            "https://cdimage.debian.org/debian-cd/current/arm64/iso-cd/debian-13.3.0-arm64-netinst.iso"
    )!
    static let diskSizeGb: UInt64 = 20
    static let vmRamMb: UInt64 = 4096
    static var vmCpus: Int {
        let host = ProcessInfo.processInfo.processorCount
        let maxAllowed = VZVirtualMachineConfiguration.maximumAllowedCPUCount
        return max(2, min(host, maxAllowed))
    }
}

struct VMConfig: Codable {
    let id: String
    var name: String
    var ramMb: Int
    var diskGb: Int
    var isoPath: String?
    var macAddress: String?
}

@MainActor
class YaaiaVMManager {
    static let shared = YaaiaVMManager()
    var runningVM:
        (
            id: String, vm: VZVirtualMachine, view: VZVirtualMachineView, automator: VZAutomator,
            delegate: VMDelegate, windowDelegate: VMWindowDelegate,
            serialBridge: SerialBridge?, serialPort: Int?
        )?

    private init() {}

    private func getOrCreateMacAddress(vmDir: URL) throws -> VZMACAddress {
        let configPath = vmDir.appendingPathComponent("config.json")
        var vmConfig: VMConfig?
        if let data = try? Data(contentsOf: configPath),
            let c = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmConfig = c
            if let macStr = c.macAddress, let addr = VZMACAddress(string: macStr) {
                return addr
            }
        }
        let mac = VZMACAddress.randomLocallyAdministered()
        let macString = mac.string
        guard var c = vmConfig else {
            return mac
        }
        c.macAddress = macString
        try? JSONEncoder().encode(c).write(to: configPath)
        print("[YaaiaVM]   network: NAT with persistent MAC \(macString)")
        return mac
    }

    func listVMs() -> [[String: Any]] {
        var result: [[String: Any]] = []
        guard
            let entries = try? FileManager.default.contentsOfDirectory(
                at: YaaiaVMConstants.vmsDir,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        else { return result }

        for url in entries {
            guard (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            let name = url.lastPathComponent
            guard name.hasPrefix("Yaaia-"), name.hasSuffix(".vm") else { continue }
            let id =
                name
                .replacingOccurrences(of: "Yaaia-", with: "")
                .replacingOccurrences(of: ".vm", with: "")

            let configPath = url.appendingPathComponent("config.json")
            var ramMb = 2048
            var diskGb = 20
            var displayName = name
            if let data = try? Data(contentsOf: configPath),
                let config = try? JSONDecoder().decode(VMConfig.self, from: data)
            {
                ramMb = config.ramMb
                diskGb = config.diskGb
                displayName = config.name
            }

            let status = runningVM?.id == id ? "running" : "stopped"
            result.append([
                "id": id,
                "name": displayName,
                "path": url.path,
                "status": status,
                "ramMb": ramMb,
                "diskGb": diskGb,
            ])
        }

        return result.sorted { ($0["id"] as? String ?? "") < ($1["id"] as? String ?? "") }
    }

    func nextVMId() -> String {
        let existing = listVMs().compactMap { $0["id"] as? String }
        let ids = existing.compactMap { Int($0) }.filter { $0 > 0 }
        let next = ids.isEmpty ? 1 : (ids.max() ?? 0) + 1
        return String(format: "%02d", next)
    }

    func createVM(isoPath: String? = nil, ramMb: Int? = nil, diskGb: Int? = nil) throws -> [String: Any] {
        try FileManager.default.createDirectory(
            at: YaaiaVMConstants.vmsDir, withIntermediateDirectories: true)
        let id = nextVMId()
        let name = "Yaaia-\(id)"
        let vmDir = YaaiaVMConstants.vmsDir.appendingPathComponent("\(name).vm")

        guard !FileManager.default.fileExists(atPath: vmDir.path) else {
            throw NSError(
                domain: "YaaiaVM", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "VM already exists"])
        }

        try FileManager.default.createDirectory(at: vmDir, withIntermediateDirectories: true)
        let dataDir = vmDir.appendingPathComponent("Data")
        try FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)

        let effectiveRamMb = ramMb ?? 4096
        let effectiveDiskGb = diskGb ?? 20

        let diskPath = dataDir.appendingPathComponent("disk.raw")
        FileManager.default.createFile(atPath: diskPath.path, contents: nil)
        let sizeBytes = UInt64(effectiveDiskGb) * 1024 * 1024 * 1024
        let handle = try FileHandle(forWritingTo: diskPath)
        try handle.truncate(atOffset: sizeBytes)
        try handle.close()

        let efiPath = dataDir.appendingPathComponent("efi_vars.fd")
        _ = try VZEFIVariableStore(creatingVariableStoreAt: efiPath, options: .allowOverwrite)

        let config = VMConfig(
            id: id, name: name, ramMb: effectiveRamMb, diskGb: effectiveDiskGb,
            isoPath: isoPath, macAddress: nil)
        let configData = try JSONEncoder().encode(config)
        try configData.write(to: vmDir.appendingPathComponent("config.json"))

        return [
            "id": id, "name": name, "path": vmDir.path, "status": "stopped",
            "ramMb": effectiveRamMb, "diskGb": effectiveDiskGb,
        ]
    }

    func createLinuxVM(at vmDir: URL) throws -> (VZVirtualMachine, FileHandle, FileHandle) {
        let dataDir = vmDir.appendingPathComponent("Data")
        let diskPath = dataDir.appendingPathComponent("disk.raw")
        let efiPath = dataDir.appendingPathComponent("efi_vars.fd")

        print("[YaaiaVM] createLinuxVM at \(vmDir.path)")

        guard FileManager.default.fileExists(atPath: diskPath.path) else {
            throw NSError(
                domain: "YaaiaVM", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Disk not found"])
        }

        let config = VZVirtualMachineConfiguration()
        config.platform = VZGenericPlatformConfiguration()

        let bootLoader = VZEFIBootLoader()
        if FileManager.default.fileExists(atPath: efiPath.path) {
            bootLoader.variableStore = VZEFIVariableStore(url: efiPath)
        }
        config.bootLoader = bootLoader

        let configPath = vmDir.appendingPathComponent("config.json")
        var vmRamMb = YaaiaVMConstants.vmRamMb
        if let data = try? Data(contentsOf: configPath),
            let vmConfig = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmRamMb = UInt64(max(4096, min(65536, vmConfig.ramMb)))
        }
        config.cpuCount = YaaiaVMConstants.vmCpus
        config.memorySize = vmRamMb * 1024 * 1024

        var storageDevices: [VZStorageDeviceConfiguration] = []
        var vmIsoPath: URL?
        if let data = try? Data(contentsOf: configPath),
            let vmConfig = try? JSONDecoder().decode(VMConfig.self, from: data),
            let path = vmConfig.isoPath, !path.isEmpty
        {
            vmIsoPath = URL(fileURLWithPath: path)
        }
        if vmIsoPath == nil {
            vmIsoPath = YaaiaVMConstants.debianIsoPath
        }
        let isoPath = vmIsoPath!
        if FileManager.default.fileExists(atPath: isoPath.path) {
            let isoAttachment = try VZDiskImageStorageDeviceAttachment(url: isoPath, readOnly: true)
            let isoBlock = VZVirtioBlockDeviceConfiguration(attachment: isoAttachment)
            storageDevices.append(isoBlock)
            print("[YaaiaVM]   ISO attached: \(isoPath.path)")
        } else {
            print("[YaaiaVM]   ISO not found at \(isoPath.path), download Debian arm64 netinst")
        }

        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: diskPath, readOnly: false, cachingMode: .cached, synchronizationMode: .full)
        let blockDevice = VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)
        storageDevices.append(blockDevice)
        config.storageDevices = storageDevices

        let networkAttachment = VZNATNetworkDeviceAttachment()
        let networkDevice = VZVirtioNetworkDeviceConfiguration()
        networkDevice.attachment = networkAttachment
        networkDevice.macAddress = try getOrCreateMacAddress(vmDir: vmDir)
        config.networkDevices = [networkDevice]

        let graphicsDevice = VZVirtioGraphicsDeviceConfiguration()
        graphicsDevice.scanouts = [
            VZVirtioGraphicsScanoutConfiguration(widthInPixels: Int(virtualDisplayWidth), heightInPixels: Int(virtualDisplayHeight))
        ]
        config.graphicsDevices = [graphicsDevice]

        config.keyboards = [VZUSBKeyboardConfiguration()]
        config.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]

        if #available(macOS 14.2, *) {
            let soundConfig = VZVirtioSoundDeviceConfiguration()
            let inputStream = VZVirtioSoundDeviceInputStreamConfiguration()
            inputStream.source = VZHostAudioInputStreamSource()
            let outputStream = VZVirtioSoundDeviceOutputStreamConfiguration()
            outputStream.sink = VZHostAudioOutputStreamSink()
            soundConfig.streams = [inputStream, outputStream]
            config.audioDevices = [soundConfig]
        }

        // Bidirectional serial: pipe1 = guest output (we read), pipe2 = guest input (we write)
        let pipe1 = Pipe()  // guest writes -> we read from pipe1.fileHandleForReading
        let pipe2 = Pipe()  // we write to pipe2.fileHandleForWriting -> guest reads
        let serialAttachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: pipe2.fileHandleForReading,
            fileHandleForWriting: pipe1.fileHandleForWriting)
        let serialConfig = VZVirtioConsoleDeviceSerialPortConfiguration()
        serialConfig.attachment = serialAttachment
        config.serialPorts = [serialConfig]
        print("[YaaiaVM]   serial: bidirectional (TCP bridge when VM starts)")

        // Shared ~/yaaia/storage/shared with write access (Linux guest: mount -t virtiofs Shared /mnt/shared)
        if #available(macOS 13.0, *) {
            let sharedURL = YaaiaVMConstants.yaaiaDir.appendingPathComponent("storage").appendingPathComponent("shared")
            try? FileManager.default.createDirectory(at: sharedURL, withIntermediateDirectories: true)
            let sharedDir = VZSharedDirectory(url: sharedURL, readOnly: false)
            let singleShare = VZSingleDirectoryShare(directory: sharedDir)
            let fsConfig = VZVirtioFileSystemDeviceConfiguration(tag: "Shared")
            fsConfig.share = singleShare
            config.directorySharingDevices = [fsConfig]
            print("[YaaiaVM]   shared: ~/yaaia/storage/shared (tag=Shared, readOnly=false). In guest: mount -t virtiofs Shared /mnt/shared")
        }

        try config.validate()
        return (VZVirtualMachine(configuration: config), pipe1.fileHandleForReading, pipe2.fileHandleForWriting)
    }

    private func ensureDebianIsoExists() async throws {
        let dest = YaaiaVMConstants.debianIsoPath
        if FileManager.default.fileExists(atPath: dest.path) {
            return
        }
        try FileManager.default.createDirectory(
            at: YaaiaVMConstants.isosDir, withIntermediateDirectories: true)
        print("[YaaiaVM]   downloading Debian ISO to \(dest.path)...")
        _ = try await downloadWithProgress(from: YaaiaVMConstants.debianIsoUrl, vmId: "_debian", to: dest)
    }

    private func downloadWithProgress(from url: URL, vmId: String, to destination: URL) async throws -> URL {
        final class DownloadDelegate: NSObject, URLSessionDownloadDelegate {
            var continuation: CheckedContinuation<URL, Error>?
            let destination: URL
            init(destination: URL) { self.destination = destination }
            func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
                do {
                    try? FileManager.default.removeItem(at: destination)
                    try FileManager.default.moveItem(at: location, to: destination)
                    continuation?.resume(returning: destination)
                } catch {
                    continuation?.resume(throwing: error)
                }
                continuation = nil
            }
            func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
                if let err = error, continuation != nil {
                    continuation?.resume(throwing: err)
                    continuation = nil
                }
            }
        }
        let delegate = DownloadDelegate(destination: destination)
        let config = URLSessionConfiguration.default
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.downloadTask(with: url)
        delegate.continuation = nil
        return try await withCheckedThrowingContinuation {
            (cont: CheckedContinuation<URL, Error>) in
            delegate.continuation = cont
            task.resume()
        }
    }

    func startVM(id: String) async throws {
        print("[YaaiaVM] startVM(\(id))")
        if runningVM?.id == id {
            return
        }

        let vmDir = YaaiaVMConstants.vmsDir.appendingPathComponent("Yaaia-\(id).vm")
        guard FileManager.default.fileExists(atPath: vmDir.path) else {
            throw NSError(domain: "YaaiaVM", code: 3, userInfo: [NSLocalizedDescriptionKey: "VM not found"])
        }

        let configPath = vmDir.appendingPathComponent("config.json")
        var vmConfig: VMConfig?
        if let data = try? Data(contentsOf: configPath),
            let c = try? JSONDecoder().decode(VMConfig.self, from: data)
        {
            vmConfig = c
        }
        let needsDefaultIso = (vmConfig?.isoPath ?? "").isEmpty
        if needsDefaultIso {
            try await ensureDebianIsoExists()
        }

        let (vm, serialRead, serialWrite) = try createLinuxVM(at: vmDir)
        let view = VZVirtualMachineView()
        view.virtualMachine = vm
        view.capturesSystemKeys = true
        if #available(macOS 14.0, *) {
            view.automaticallyReconfiguresDisplay = false
        }

        let automator = VZAutomator(view: view)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: virtualDisplayWidth, height: virtualDisplayHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Yaaia-\(id) — VM Console"
        window.contentView?.addSubview(view)
        view.frame = window.contentView?.bounds ?? .zero
        view.autoresizingMask = [.width, .height]
        window.center()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)

        let windowDelegate = VMWindowDelegate(vmId: id)
        window.delegate = windowDelegate

        let delegate = VMDelegate()
        vm.delegate = delegate

        print("[YaaiaVM]   starting VM...")
        try await vm.start()
        print("[YaaiaVM]   VM started, state=\(vm.state.rawValue)")

        reconfigureDisplayToFullHD(vm)

        let bridge = SerialBridge(serialRead: serialRead, serialWrite: serialWrite, vmId: id)
        let serialPort = bridge.start()
        let serialPortFile = YaaiaVMConstants.yaaiaDir.appendingPathComponent("vm-\(id)-serial.port")
        try? String(serialPort).write(to: serialPortFile, atomically: true, encoding: .utf8)

        runningVM = (id, vm, view, automator, delegate, windowDelegate, bridge, serialPort)
        print("[YaaiaVM] startVM done. Serial bridge on port \(serialPort). Note: empty disk = black screen until you install an OS (attach ISO).")
    }

    /// Reconfigure all graphics displays to virtual resolution. Fixes display output.
    private func reconfigureDisplayToFullHD(_ vm: VZVirtualMachine) {
        guard #available(macOS 14.0, *) else { return }
        let targetSize = CGSize(width: virtualDisplayWidth, height: virtualDisplayHeight)
        for device in vm.graphicsDevices {
            for display in device.displays {
                let current = display.sizeInPixels
                guard current.width != targetSize.width || current.height != targetSize.height else {
                    continue
                }
                do {
                    try display.reconfigure(sizeInPixels: targetSize)
                    print("[YaaiaVM]   display reconfigured \(Int(current.width))×\(Int(current.height)) → \(Int(virtualDisplayWidth))×\(Int(virtualDisplayHeight))")
                } catch {
                    print("[YaaiaVM]   display reconfigure failed: \(error.localizedDescription)")
                }
            }
        }
    }

    func serialPort(forVMId id: String) -> Int? {
        guard runningVM?.id == id else { return nil }
        return runningVM?.serialPort
    }

    func showConsole(id: String) {
        guard runningVM?.id == id, let view = runningVM?.view else { return }
        if let win = view.window {
            win.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: virtualDisplayWidth, height: virtualDisplayHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Yaaia-\(id) — VM Console"
        window.contentView?.addSubview(view)
        view.frame = window.contentView?.bounds ?? .zero
        view.autoresizingMask = [.width, .height]
        window.center()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let windowDelegate = runningVM?.windowDelegate {
            window.delegate = windowDelegate
        }
    }

    private func stopVMWithTimeout(_ vm: VZVirtualMachine) async throws {
        let stopTimeoutNs: UInt64 = 30_000_000_000
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask { try await vm.stop() }
            group.addTask {
                try await Task.sleep(nanoseconds: stopTimeoutNs)
                throw NSError(domain: "YaaiaVM", code: 5,
                    userInfo: [NSLocalizedDescriptionKey: "VM stop timed out"])
            }
            _ = try await group.next()
            group.cancelAll()
        }
    }

    func stopVM(id: String, force: Bool = false) async throws {
        guard runningVM?.id == id else { return }
        guard let vm = runningVM?.vm else { return }
        let window = runningVM?.view.window
        let automator = runningVM?.automator
        let bridge = runningVM?.serialBridge

        bridge?.stop()
        try? FileManager.default.removeItem(at: YaaiaVMConstants.yaaiaDir.appendingPathComponent("vm-\(id)-serial.port"))

        if !force, let automator = automator {
            print("[YaaiaVM] Sending ACPI power button for graceful shutdown")
            window?.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            do {
                try await automator.press(key: .keyboardPower)
                try await Task.sleep(nanoseconds: 2_000_000_000)
            } catch { }
        }

        if !force && vm.canRequestStop {
            do {
                try vm.requestStop()
                let timeoutNs: UInt64 = 60_000_000_000
                let interval: UInt64 = 500_000_000
                var elapsed: UInt64 = 0
                while elapsed < timeoutNs, runningVM?.id == id {
                    try await Task.sleep(nanoseconds: interval)
                    elapsed += interval
                }
                if runningVM?.id == id {
                    do { try await stopVMWithTimeout(vm) } catch { }
                    runningVM = nil
                }
            } catch {
                do { try await stopVMWithTimeout(vm) } catch { }
                runningVM = nil
            }
        } else {
            do { try await stopVMWithTimeout(vm) } catch { }
            runningVM = nil
        }

        window?.orderOut(nil as Any?)
    }

    func deleteVM(id: String) async throws {
        if runningVM?.id == id {
            try await stopVM(id: id)
        }
        let vmDir = YaaiaVMConstants.vmsDir.appendingPathComponent("Yaaia-\(id).vm")
        try FileManager.default.removeItem(at: vmDir)
    }
}

class VMWindowDelegate: NSObject, NSWindowDelegate {
    let vmId: String
    init(vmId: String) {
        self.vmId = vmId
        super.init()
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard let running = YaaiaVMManager.shared.runningVM, running.id == vmId else {
            return true
        }
        sender.miniaturize(nil)
        return false
    }
}

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        Task { @MainActor in
            if let id = YaaiaVMManager.shared.runningVM?.id {
                YaaiaVMManager.shared.runningVM?.serialBridge?.stop()
                try? FileManager.default.removeItem(at: YaaiaVMConstants.yaaiaDir.appendingPathComponent("vm-\(id)-serial.port"))
            }
            YaaiaVMManager.shared.runningVM = nil
        }
    }
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        Task { @MainActor in
            if let id = YaaiaVMManager.shared.runningVM?.id {
                YaaiaVMManager.shared.runningVM?.serialBridge?.stop()
                try? FileManager.default.removeItem(at: YaaiaVMConstants.yaaiaDir.appendingPathComponent("vm-\(id)-serial.port"))
            }
            YaaiaVMManager.shared.runningVM = nil
        }
    }
}
