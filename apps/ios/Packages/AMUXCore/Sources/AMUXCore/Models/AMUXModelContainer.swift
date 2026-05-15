import Foundation
import SwiftData

public enum AMUXModelContainerFactory {
    public static func make() throws -> ModelContainer {
        let schema = Schema(versionedSchema: AMUXSchemaV1.self)
        let storeURL = try persistentStoreURL()
        let config = ModelConfiguration(schema: schema, url: storeURL)

        do {
            return try ModelContainer(for: schema, configurations: config)
        } catch {
            // The local SwiftData store is only a cache of daemon-backed state.
            // If migration fails, drop the cache and let the app repopulate it
            // instead of crashing at launch.
            try removeStoreFiles(at: storeURL)
            return try ModelContainer(for: schema, configurations: config)
        }
    }

    private static func persistentStoreURL() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let bundleID = Bundle.main.bundleIdentifier ?? "tech.teamclaw.mobile"
        let directory = appSupport.appendingPathComponent(bundleID, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let storeURL = directory.appendingPathComponent("teamclaw.store")
        let legacyURL = directory.appendingPathComponent("amux.store")
        try moveStoreFilesIfNeeded(from: legacyURL, to: storeURL)
        return storeURL
    }

    private static func moveStoreFilesIfNeeded(from oldURL: URL, to newURL: URL) throws {
        let fm = FileManager.default
        guard !fm.fileExists(atPath: newURL.path), fm.fileExists(atPath: oldURL.path) else { return }
        for (oldFile, newFile) in storeFilePairs(from: oldURL, to: newURL) where fm.fileExists(atPath: oldFile.path) {
            try fm.moveItem(at: oldFile, to: newFile)
        }
    }

    private static func removeStoreFiles(at url: URL) throws {
        let fm = FileManager.default
        let candidates = storeFiles(for: url)
        for candidate in candidates where fm.fileExists(atPath: candidate.path) {
            try fm.removeItem(at: candidate)
        }
    }

    private static func storeFiles(for url: URL) -> [URL] {
        [
            url,
            url.appendingPathExtension("shm"),
            url.appendingPathExtension("wal"),
        ]
    }

    private static func storeFilePairs(from oldURL: URL, to newURL: URL) -> [(URL, URL)] {
        zip(storeFiles(for: oldURL), storeFiles(for: newURL)).map { pair in (pair.0, pair.1) }
    }
}
