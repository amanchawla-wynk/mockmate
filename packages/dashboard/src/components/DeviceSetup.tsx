/**
 * Device Setup component
 * Shows server URLs and links to device setup page
 */

import { useState, useEffect } from 'react';

interface DeviceSetupProps {
  httpPort?: number;
  httpsPort?: number;
}

interface NetworkInfo {
  httpURLs: string[];
  httpsURLs: string[];
  setupURL: string;
  qrCodeURL: string;
}

export function DeviceSetup({ httpPort = 3456, httpsPort = 3457 }: DeviceSetupProps) {
  const [networkInfo, setNetworkInfo] = useState<NetworkInfo | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // In a browser environment, we can only reliably get localhost
    // The actual IPs are shown on the setup page
    const baseHTTP = `http://localhost:${httpPort}`;
    const baseHTTPS = `https://localhost:${httpsPort}`;

    setNetworkInfo({
      httpURLs: [baseHTTP],
      httpsURLs: [baseHTTPS],
      setupURL: `${baseHTTP}/setup`,
      qrCodeURL: `${baseHTTP}/setup/qr`,
    });
  }, [httpPort, httpsPort]);

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  if (!networkInfo) return null;

  return (
    <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-purple-100 transition-colors"
      >
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-gradient-to-r from-purple-500 to-indigo-600 rounded-lg flex items-center justify-center">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="text-left">
            <h3 className="text-lg font-semibold text-gray-900">Device Setup</h3>
            <p className="text-sm text-gray-600">Configure HTTPS for physical devices</p>
          </div>
        </div>
        <svg
          className={`w-5 h-5 text-gray-500 transition-transform ${isExpanded ? 'transform rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded Content */}
      {isExpanded && (
        <div className="px-6 pb-6 space-y-4">
          {/* Setup Page Link */}
          <div className="bg-white rounded-lg p-4 border border-purple-200">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <div className="flex items-center space-x-2 mb-2">
                  <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                  </svg>
                  <h4 className="font-semibold text-gray-900">Setup Page</h4>
                </div>
                <p className="text-sm text-gray-600 mb-3">
                  Open this page on your mobile device to install certificates
                </p>
                <div className="flex items-center space-x-2">
                  <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded text-sm font-mono text-gray-700">
                    {networkInfo.setupURL}
                  </code>
                  <button
                    onClick={() => copyToClipboard(networkInfo.setupURL)}
                    className="px-3 py-2 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-sm font-medium"
                  >
                    {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-4 border-t border-gray-200">
              <a
                href={networkInfo.setupURL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center space-x-2 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 transition-all shadow-md hover:shadow-lg font-medium"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                <span>Open Setup Page</span>
              </a>
            </div>
          </div>

          {/* QR Code */}
          <div className="bg-white rounded-lg p-4 border border-purple-200">
            <div className="flex items-center space-x-2 mb-3">
              <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
              </svg>
              <h4 className="font-semibold text-gray-900">Quick Access</h4>
            </div>
            <div className="flex items-center space-x-4">
              <img
                src={networkInfo.qrCodeURL}
                alt="Setup Page QR Code"
                className="w-32 h-32 border-4 border-white rounded-lg shadow-md"
              />
              <div className="flex-1">
                <p className="text-sm text-gray-600 mb-2">
                  Scan this QR code with your mobile device to quickly access the setup page
                </p>
                <p className="text-xs text-gray-500">
                  Works with iOS Camera app or any QR code scanner
                </p>
              </div>
            </div>
          </div>

          {/* Server URLs */}
          <div className="grid grid-cols-2 gap-4">
            {/* HTTP */}
            <div className="bg-white rounded-lg p-4 border border-gray-200">
              <div className="flex items-center space-x-2 mb-2">
                <div className="w-2 h-2 bg-blue-500 rounded-full"></div>
                <h4 className="font-semibold text-gray-900 text-sm">HTTP Server</h4>
              </div>
              <p className="text-xs text-gray-600 mb-2">For simulators/emulators</p>
              <code className="block px-2 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-mono text-gray-700">
                {networkInfo.httpURLs[0]}
              </code>
            </div>

            {/* HTTPS */}
            <div className="bg-white rounded-lg p-4 border border-gray-200">
              <div className="flex items-center space-x-2 mb-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <h4 className="font-semibold text-gray-900 text-sm">HTTPS Server</h4>
              </div>
              <p className="text-xs text-gray-600 mb-2">For physical devices</p>
              <code className="block px-2 py-1 bg-gray-50 border border-gray-200 rounded text-xs font-mono text-gray-700">
                {networkInfo.httpsURLs[0]}
              </code>
            </div>
          </div>

          {/* Instructions */}
          <div className="bg-purple-50 border border-purple-200 rounded-lg p-4">
            <h4 className="font-semibold text-purple-900 mb-2 text-sm">Setup Instructions</h4>
            <ol className="text-xs text-purple-700 space-y-1 list-decimal list-inside">
              <li>Open the setup page on your mobile device (scan QR or visit URL)</li>
              <li>Download and install the certificate for your platform (iOS/Android)</li>
              <li>Enable certificate trust in device settings</li>
              <li>Use the HTTPS URL in your mobile app</li>
            </ol>
          </div>

          {/* Warning */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-start space-x-2">
              <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className="flex-1">
                <p className="text-xs font-medium text-amber-900">Important</p>
                <p className="text-xs text-amber-700 mt-1">
                  Make sure your mobile device is connected to the same WiFi network as this computer. The actual local IP address will be shown on the setup page.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
