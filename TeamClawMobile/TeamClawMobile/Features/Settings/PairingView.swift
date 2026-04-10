import SwiftUI
import AVFoundation

// MARK: - PairingView

struct PairingView: View {
    @ObservedObject var pairingManager: PairingManager

    @State private var code = ""
    @State private var mqttHost: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_host") ?? ""
    @State private var mqttPort: String = {
        let saved = UserDefaults.standard.integer(forKey: "teamclaw_pairing_broker_port")
        return saved > 0 ? String(saved) : "8883"
    }()
    @State private var mqttUsername: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_username") ?? ""
    @State private var mqttPassword: String = UserDefaults.standard.string(forKey: "teamclaw_pairing_broker_password") ?? ""
    @State private var showScanner = false
    @State private var showManualEntry = false
    @FocusState private var focusedField: Field?

    private enum Field {
        case host, port, username, password, code
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer().frame(height: 40)

                // Icon
                Image(systemName: "link.badge.plus")
                    .font(.system(size: 56))
                    .foregroundStyle(.blue)

                // Title and subtitle
                VStack(spacing: 8) {
                    Text("连接桌面端")
                        .font(.title.bold())

                    Text("扫描桌面端显示的二维码即可配对")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }

                // Scan QR button
                Button {
                    showScanner = true
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "qrcode.viewfinder")
                            .font(.title2)
                        Text("扫码配对")
                            .font(.headline)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal, 40)

                // Error text
                if let error = pairingManager.pairingError {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(.horizontal, 40)
                }

                // Pairing progress
                if pairingManager.isPairing {
                    HStack(spacing: 8) {
                        ProgressView()
                        Text("正在配对...")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }

                // Manual entry toggle
                Button {
                    withAnimation {
                        showManualEntry.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("手动输入")
                            .font(.subheadline)
                        Image(systemName: showManualEntry ? "chevron.up" : "chevron.down")
                            .font(.caption)
                    }
                    .foregroundStyle(.secondary)
                }

                if showManualEntry {
                    manualEntrySection
                }

                Spacer().frame(height: 20)
            }
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { result in
                showScanner = false
                handleQRResult(result)
            }
        }
    }

    // MARK: - Manual Entry

    private var manualEntrySection: some View {
        VStack(spacing: 20) {
            // MQTT Server section
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "server.rack")
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    Text("MQTT 服务器")
                        .font(.subheadline.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 40)

                VStack(spacing: 10) {
                    HStack(spacing: 8) {
                        TextField("服务器地址", text: $mqttHost)
                            .textContentType(.URL)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .focused($focusedField, equals: .host)
                        TextField("端口", text: $mqttPort)
                            .keyboardType(.numberPad)
                            .focused($focusedField, equals: .port)
                            .frame(width: 70)
                    }
                    .textFieldStyle(.roundedBorder)

                    HStack(spacing: 8) {
                        TextField("用户名（可选）", text: $mqttUsername)
                            .autocapitalization(.none)
                            .disableAutocorrection(true)
                            .focused($focusedField, equals: .username)
                        SecureField("密码（可选）", text: $mqttPassword)
                            .focused($focusedField, equals: .password)
                    }
                    .textFieldStyle(.roundedBorder)
                }
                .padding(.horizontal, 40)
            }

            // Code input
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: "number")
                        .foregroundStyle(.secondary)
                        .frame(width: 20)
                    Text("配对码")
                        .font(.subheadline.bold())
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 40)

                TextField("000000", text: $code)
                    .font(.system(.title, design: .monospaced).bold())
                    .multilineTextAlignment(.center)
                    .keyboardType(.numberPad)
                    .textContentType(.oneTimeCode)
                    .focused($focusedField, equals: .code)
                    .onChange(of: code) { _, newValue in
                        let filtered = newValue.filter(\.isNumber)
                        if filtered.count > 6 {
                            code = String(filtered.prefix(6))
                        } else if filtered != newValue {
                            code = filtered
                        }
                    }
                    .padding(.horizontal, 40)

                Divider()
                    .padding(.horizontal, 40)
            }

            // Pair button
            Button {
                saveBrokerInfo()
                pairingManager.pair(
                    with: code,
                    brokerHost: mqttHost,
                    brokerPort: UInt16(mqttPort) ?? 8883,
                    brokerUsername: mqttUsername.isEmpty ? nil : mqttUsername,
                    brokerPassword: mqttPassword.isEmpty ? nil : mqttPassword
                )
            } label: {
                Group {
                    if pairingManager.isPairing {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Text("配对")
                            .font(.headline)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(mqttHost.isEmpty || code.count != 6 || pairingManager.isPairing)
            .padding(.horizontal, 40)
        }
        .transition(.opacity.combined(with: .move(edge: .top)))
    }

    // MARK: - QR Handling

    private func handleQRResult(_ content: String) {
        guard let data = content.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let host = json["host"] as? String,
              let codeValue = json["code"] as? String
        else {
            pairingManager.pairingError = "无效的二维码"
            return
        }

        let port = json["port"] as? Int ?? 8883
        let username = json["user"] as? String
        let password = json["pass"] as? String

        // Update fields
        mqttHost = host
        mqttPort = String(port)
        mqttUsername = username ?? ""
        mqttPassword = password ?? ""
        code = codeValue

        saveBrokerInfo()

        // Auto-pair
        pairingManager.pair(
            with: codeValue,
            brokerHost: host,
            brokerPort: UInt16(port),
            brokerUsername: username,
            brokerPassword: password
        )
    }

    private func saveBrokerInfo() {
        let ud = UserDefaults.standard
        ud.set(mqttHost, forKey: "teamclaw_pairing_broker_host")
        ud.set(Int(mqttPort) ?? 8883, forKey: "teamclaw_pairing_broker_port")
        ud.set(mqttUsername, forKey: "teamclaw_pairing_broker_username")
        ud.set(mqttPassword, forKey: "teamclaw_pairing_broker_password")
    }
}

// MARK: - QRScannerView

struct QRScannerView: UIViewControllerRepresentable {
    let onResult: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        let vc = QRScannerViewController()
        vc.onResult = onResult
        return vc
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onResult: ((String) -> Void)?

    private let captureSession = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var hasReported = false

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              captureSession.canAddInput(input)
        else {
            showError("无法访问相机")
            return
        }

        captureSession.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard captureSession.canAddOutput(output) else {
            showError("无法初始化扫描器")
            return
        }
        captureSession.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: captureSession)
        preview.videoGravity = .resizeAspectFill
        preview.frame = view.bounds
        view.layer.addSublayer(preview)
        previewLayer = preview

        // Overlay UI
        addOverlay()

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.captureSession.startRunning()
        }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        captureSession.stopRunning()
    }

    private func addOverlay() {
        // Close button
        let closeButton = UIButton(type: .system)
        closeButton.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        closeButton.tintColor = .white
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        closeButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        view.addSubview(closeButton)

        // Hint label
        let hintLabel = UILabel()
        hintLabel.text = "扫描桌面端的配对二维码"
        hintLabel.textColor = .white
        hintLabel.font = .systemFont(ofSize: 16, weight: .medium)
        hintLabel.textAlignment = .center
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)

        // Scan frame
        let frameSize: CGFloat = 250
        let scanFrame = UIView()
        scanFrame.layer.borderColor = UIColor.white.cgColor
        scanFrame.layer.borderWidth = 2
        scanFrame.layer.cornerRadius = 12
        scanFrame.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scanFrame)

        NSLayoutConstraint.activate([
            closeButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 16),
            closeButton.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            closeButton.widthAnchor.constraint(equalToConstant: 32),
            closeButton.heightAnchor.constraint(equalToConstant: 32),

            scanFrame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            scanFrame.centerYAnchor.constraint(equalTo: view.centerYAnchor, constant: -40),
            scanFrame.widthAnchor.constraint(equalToConstant: frameSize),
            scanFrame.heightAnchor.constraint(equalToConstant: frameSize),

            hintLabel.topAnchor.constraint(equalTo: scanFrame.bottomAnchor, constant: 24),
            hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    @objc private func closeTapped() {
        dismiss(animated: true)
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !hasReported,
              let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              object.type == .qr,
              let value = object.stringValue
        else { return }

        hasReported = true
        captureSession.stopRunning()

        // Haptic feedback
        let generator = UINotificationFeedbackGenerator()
        generator.notificationOccurred(.success)

        dismiss(animated: true) { [weak self] in
            self?.onResult?(value)
        }
    }

    private func showError(_ message: String) {
        let label = UILabel()
        label.text = message
        label.textColor = .white
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }
}

// MARK: - Preview

#Preview {
    PairingView(pairingManager: PairingManager())
}
