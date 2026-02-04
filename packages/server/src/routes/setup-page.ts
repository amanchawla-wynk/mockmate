/**
 * Device Setup Page HTML
 * Static HTML page for device setup instructions
 */

export function setupPageHTML(primaryIP: string, httpsPort: number, allIPs: string[], proxyPort: number = 8888): string {
  const httpsURL = `https://${primaryIP}:${httpsPort}`;
  const httpURL = `http://${primaryIP}:3456`; // For setup access

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MockMate Device Setup</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 900px;
            margin: 0 auto;
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px;
            text-align: center;
            position: relative;
        }

        .header h1 {
            font-size: 2.5rem;
            margin-bottom: 10px;
            font-weight: 700;
        }

        .header p {
            font-size: 1.1rem;
            opacity: 0.95;
        }

        .content {
            padding: 40px;
        }

        .section {
            margin-bottom: 40px;
        }

        .section h2 {
            font-size: 1.8rem;
            margin-bottom: 20px;
            color: #333;
            border-bottom: 3px solid #667eea;
            padding-bottom: 10px;
        }

        .qr-container {
            text-align: center;
            padding: 30px;
            background: #f7f9fc;
            border-radius: 12px;
            margin: 20px 0;
        }

        .qr-container img {
            max-width: 300px;
            border: 4px solid white;
            border-radius: 12px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .qr-container p {
            margin-top: 15px;
            color: #666;
            font-size: 0.95rem;
        }

        .url-box {
            background: #f7f9fc;
            border: 2px solid #667eea;
            border-radius: 8px;
            padding: 20px;
            margin: 20px 0;
            font-family: 'Courier New', monospace;
            word-break: break-all;
        }

        .url-box .label {
            font-weight: bold;
            color: #667eea;
            margin-bottom: 10px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto;
        }

        .url-box .url {
            font-size: 1.1rem;
            color: #333;
        }

        .steps {
            counter-reset: step-counter;
            list-style: none;
        }

        .steps li {
            counter-increment: step-counter;
            margin-bottom: 20px;
            padding-left: 50px;
            position: relative;
            min-height: 40px;
        }

        .steps li::before {
            content: counter(step-counter);
            position: absolute;
            left: 0;
            top: 0;
            width: 35px;
            height: 35px;
            background: #667eea;
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-weight: bold;
            font-size: 1.1rem;
        }

        .platform-tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #e0e0e0;
        }

        .tab-button {
            padding: 12px 24px;
            background: none;
            border: none;
            border-bottom: 3px solid transparent;
            cursor: pointer;
            font-size: 1.1rem;
            font-weight: 600;
            color: #666;
            transition: all 0.3s ease;
        }

        .tab-button:hover {
            color: #667eea;
        }

        .tab-button.active {
            color: #667eea;
            border-bottom-color: #667eea;
        }

        .tab-content {
            display: none;
        }

        .tab-content.active {
            display: block;
            animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .download-button {
            display: inline-block;
            padding: 15px 30px;
            background: #667eea;
            color: white;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 1.1rem;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.3);
        }

        .download-button:hover {
            background: #5568d3;
            transform: translateY(-2px);
            box-shadow: 0 6px 16px rgba(102, 126, 234, 0.4);
        }

        .test-button {
            display: inline-block;
            padding: 15px 30px;
            background: #10b981;
            color: white;
            text-decoration: none;
            border: none;
            border-radius: 8px;
            font-weight: 600;
            font-size: 1.1rem;
            cursor: pointer;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .test-button:hover {
            background: #059669;
            transform: translateY(-2px);
        }

        .test-result {
            margin-top: 15px;
            padding: 15px;
            border-radius: 8px;
            font-weight: 600;
            display: none;
        }

        .test-result.success {
            background: #d1fae5;
            color: #065f46;
            border: 2px solid #10b981;
        }

        .test-result.error {
            background: #fee2e2;
            color: #991b1b;
            border: 2px solid #ef4444;
        }

        .warning {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            border-radius: 4px;
            margin: 20px 0;
        }

        .warning strong {
            color: #92400e;
        }

        .code-block {
            background: #1f1f1f;
            color: #e0e0e0;
            padding: 20px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 15px 0;
            font-family: 'Courier New', monospace;
            font-size: 0.9rem;
        }

        .footer {
            background: #f7f9fc;
            padding: 30px;
            text-align: center;
            color: #666;
            border-top: 1px solid #e0e0e0;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 2rem;
            }

            .content {
                padding: 20px;
            }

            .section h2 {
                font-size: 1.5rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div style="position: absolute; top: 20px; left: 20px;">
                <a href="/" style="display: inline-flex; align-items: center; gap: 8px; color: white; text-decoration: none; background: rgba(255, 255, 255, 0.2); padding: 8px 16px; border-radius: 8px; font-size: 14px; font-weight: 500; transition: background 0.2s;" onmouseover="this.style.background='rgba(255, 255, 255, 0.3)'" onmouseout="this.style.background='rgba(255, 255, 255, 0.2)'">
                    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                    </svg>
                    <span>Back to Dashboard</span>
                </a>
            </div>
            <h1>🚀 MockMate Device Setup</h1>
            <p>Configure your iOS or Android device for HTTPS testing</p>
        </div>

        <div class="content">
            <!-- QR Code Section -->
            <div class="section">
                <h2>📱 Quick Setup</h2>
                <div class="qr-container">
                    <img src="/setup/qr" alt="Setup QR Code">
                    <p>Scan this QR code with your device to open this page</p>
                </div>
            </div>

            <!-- Server URLs -->
            <div class="section">
                <h2>🌐 Server Information</h2>
                <div class="url-box">
                    <div class="label">HTTPS URL (use this in your app):</div>
                    <div class="url">${httpsURL}</div>
                </div>
                ${allIPs.length > 1 ? `
                <p><strong>Available on multiple IPs:</strong></p>
                <ul>
                    ${allIPs.map(ip => `<li>https://${ip}:${httpsPort}</li>`).join('')}
                </ul>
                ` : ''}
            </div>

            <!-- Proxy Mode -->
            <div class="section">
                <h2>🔀 Proxy Mode (Transparent Interception)</h2>
                <p style="margin-bottom: 15px;">
                    Instead of pointing your app to MockMate's URL, you can configure your device to use MockMate
                    as an HTTP proxy. This lets your app call real API URLs while MockMate intercepts and returns mocks.
                </p>
                <div class="url-box">
                    <div class="label">HTTP Proxy Address:</div>
                    <div class="url">${primaryIP}:${proxyPort}</div>
                </div>
                <ol class="steps">
                    <li>
                        <strong>Install the CA certificate</strong> (see below) — required for HTTPS interception
                    </li>
                    <li>
                        <strong>Configure your device WiFi proxy:</strong><br>
                        <em>iOS:</em> Settings → WiFi → tap your network → Configure Proxy → Manual → Server: <code>${primaryIP}</code>, Port: <code>${proxyPort}</code><br>
                        <em>Android:</em> Settings → WiFi → long-press your network → Modify → Proxy: Manual → Host: <code>${primaryIP}</code>, Port: <code>${proxyPort}</code>
                    </li>
                    <li>
                        <strong>Set your project's Base URL</strong> to the real API (e.g., <code>https://api.example.com</code>) in the MockMate dashboard
                    </li>
                    <li>
                        <strong>Use your app normally</strong> — MockMate will intercept matching requests and return mocks
                    </li>
                </ol>
                <div class="warning">
                    <strong>💡 Tip:</strong> Only requests to your project's Base URL domain are intercepted.
                    All other traffic (Google, Apple, etc.) passes through unmodified.
                </div>
            </div>

            <!-- Platform Tabs -->
            <div class="section">
                <h2>⚙️ Certificate Setup Instructions</h2>
                <div class="platform-tabs">
                    <button class="tab-button active" onclick="switchTab('ios')">iOS</button>
                    <button class="tab-button" onclick="switchTab('android')">Android</button>
                </div>

                <!-- iOS Instructions -->
                <div id="ios-tab" class="tab-content active">
                    <h3>Method 1: Configuration Profile (Recommended)</h3>
                    <ol class="steps">
                        <li>
                            <strong>Download the Profile:</strong><br>
                            <a href="/setup/ios-profile" class="download-button" style="margin-top: 10px;">
                                📥 Download iOS Profile
                            </a>
                        </li>
                        <li>
                            <strong>Install the Profile:</strong><br>
                            Tap "Allow" when prompted to download. Then go to Settings → General → VPN & Device Management → MockMate HTTPS Certificate → Install
                        </li>
                        <li>
                            <strong>Enable Full Trust:</strong><br>
                            Go to Settings → General → About → Certificate Trust Settings → Enable full trust for "MockMate CA"
                        </li>
                        <li>
                            <strong>Test Connection:</strong><br>
                            Click the button below to verify HTTPS works:
                            <div style="margin-top: 10px;">
                                <button class="test-button" onclick="testConnection()">🔍 Test HTTPS Connection</button>
                                <div id="test-result" class="test-result"></div>
                            </div>
                        </li>
                    </ol>

                    <h3 style="margin-top: 40px;">Method 2: Manual Certificate</h3>
                    <ol class="steps">
                        <li>
                            <a href="/setup/ca.crt" class="download-button">📥 Download CA Certificate</a>
                        </li>
                        <li>
                            AirDrop the file to your iOS device or email it to yourself
                        </li>
                        <li>
                            Open the certificate file on your device and follow the installation steps
                        </li>
                        <li>
                            Enable full trust in Settings → General → About → Certificate Trust Settings
                        </li>
                    </ol>

                    <div class="warning">
                        <strong>⚠️ Important:</strong> Make sure to enable "Full Trust" in Certificate Trust Settings, otherwise HTTPS connections will fail.
                    </div>
                </div>

                <!-- Android Instructions -->
                <div id="android-tab" class="tab-content">
                    <h3>Step 1: Install CA Certificate</h3>
                    <ol class="steps">
                        <li>
                            <strong>Download Certificate:</strong><br>
                            <a href="/setup/ca.crt" class="download-button" style="margin-top: 10px;">
                                📥 Download CA Certificate
                            </a>
                        </li>
                        <li>
                            <strong>Install Certificate:</strong><br>
                            Go to Settings → Security → Install from storage (or Certificate → Install certificates)
                        </li>
                        <li>
                            Select the downloaded "mockmate-ca.crt" file
                        </li>
                        <li>
                            Name it "MockMate CA" and select "VPN and apps" for usage
                        </li>
                    </ol>

                    <h3 style="margin-top: 40px;">Step 2: Configure Your App (Optional)</h3>
                    <p>If your app targets Android 7.0+, you may need to add a network security configuration:</p>

                    <ol class="steps">
                        <li>
                            <strong>Download Config:</strong><br>
                            <a href="/setup/android-config" class="download-button" style="margin-top: 10px;">
                                📥 Download Network Config
                            </a>
                        </li>
                        <li>
                            <strong>Add to Your App:</strong><br>
                            Place the file in <code>res/xml/network_security_config.xml</code>
                        </li>
                        <li>
                            <strong>Update AndroidManifest.xml:</strong>
                            <div class="code-block">&lt;application
    android:networkSecurityConfig="@xml/network_security_config"
    ...&gt;</div>
                        </li>
                    </ol>

                    <div class="warning">
                        <strong>💡 Tip:</strong> For development builds, you can simply install the certificate as a user certificate and it should work without app configuration.
                    </div>

                    <h3 style="margin-top: 40px;">Step 3: Test Connection</h3>
                    <button class="test-button" onclick="testConnection()">🔍 Test HTTPS Connection</button>
                    <div id="test-result-android" class="test-result"></div>
                </div>
            </div>

            <!-- Troubleshooting -->
            <div class="section">
                <h2>🔧 Troubleshooting</h2>
                <ul style="padding-left: 20px;">
                    <li><strong>Certificate not trusted:</strong> Make sure you enabled "Full Trust" (iOS) or installed as "VPN and apps" (Android)</li>
                    <li><strong>Connection refused:</strong> Verify both devices are on the same WiFi network</li>
                    <li><strong>Hostname mismatch:</strong> Use the IP address shown above, not "localhost"</li>
                    <li><strong>Still not working:</strong> Try restarting the MockMate server and reinstalling the certificate</li>
                </ul>
            </div>
        </div>

        <div class="footer">
            <p>MockMate v2 - Local Mock API Server</p>
            <p style="margin-top: 10px; font-size: 0.9rem;">
                Server running on: ${allIPs.map(ip => `${ip}:${httpsPort}`).join(', ')}
            </p>
            <div style="margin-top: 20px;">
                <a href="/" style="display: inline-flex; align-items: center; gap: 8px; color: #667eea; text-decoration: none; background: white; padding: 10px 20px; border-radius: 8px; border: 2px solid #667eea; font-size: 14px; font-weight: 600; transition: all 0.2s;" onmouseover="this.style.background='#667eea'; this.style.color='white'" onmouseout="this.style.background='white'; this.style.color='#667eea'">
                    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"/>
                    </svg>
                    <span>Back to Dashboard</span>
                </a>
            </div>
        </div>
    </div>

    <script>
        function switchTab(platform) {
            // Update buttons
            document.querySelectorAll('.tab-button').forEach(btn => {
                btn.classList.remove('active');
            });
            event.target.classList.add('active');

            // Update content
            document.querySelectorAll('.tab-content').forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(platform + '-tab').classList.add('active');
        }

        async function testConnection() {
            const resultDiv = document.getElementById('test-result') || document.getElementById('test-result-android');
            resultDiv.style.display = 'block';
            resultDiv.textContent = 'Testing connection...';
            resultDiv.className = 'test-result';

            try {
                const response = await fetch('${httpsURL}/setup/test');
                const data = await response.json();

                if (data.success) {
                    resultDiv.className = 'test-result success';
                    resultDiv.textContent = '✅ Success! HTTPS connection is working correctly.';
                } else {
                    throw new Error('Test failed');
                }
            } catch (error) {
                resultDiv.className = 'test-result error';
                const errorMsg = error instanceof Error ? error.message : 'Unknown error';
                resultDiv.innerHTML = '❌ Connection failed. Make sure the certificate is installed and trusted.<br><small style="color: #666; margin-top: 8px; display: block;">Error: ' + errorMsg + '</small>';
                console.error('Connection test error:', error);
            }
        }
    </script>
</body>
</html>`;
}
