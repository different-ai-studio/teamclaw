import Foundation
import UIKit
import Alamofire

final class OSSUploader {
    struct Config {
        let endpoint: String      // e.g. "https://bucket.oss-cn-hangzhou.aliyuncs.com"
        let accessKeyID: String
        let accessKeySecret: String
        let bucket: String
        let pathPrefix: String    // e.g. "mobile/images/"
    }

    private let config: Config

    init(config: Config) {
        self.config = config
    }

    func upload(image: UIImage, completion: @escaping (Result<String, Error>) -> Void) {
        guard let data = image.jpegData(compressionQuality: 0.8) else {
            completion(.failure(OSSError.compressionFailed))
            return
        }

        let filename = "\(config.pathPrefix)\(UUID().uuidString).jpg"
        let url = "\(config.endpoint)/\(filename)"

        // Simplified upload — in production, use STS token or pre-signed URL
        AF.upload(data, to: url, method: .put, headers: [
            "Content-Type": "image/jpeg"
        ])
        .validate(statusCode: 200..<300)
        .response { response in
            switch response.result {
            case .success:
                completion(.success(url))
            case .failure(let error):
                completion(.failure(error))
            }
        }
    }

    enum OSSError: LocalizedError {
        case compressionFailed
        var errorDescription: String? {
            switch self {
            case .compressionFailed: return "图片压缩失败"
            }
        }
    }
}
